import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateLineItemAmount,
  calculateEstimateTotals,
  isValidTransition,
  hashPayload,
  formatMoney,
  generateEstimateNumber,
  ESTIMATE_LIFECYCLE_TRANSITIONS,
  EstimateService,
} from '@/lib/estimate-service';
import { EstimateStatus } from '@/lib/estimate-types';

describe('Estimate Service - Money Correctness (Minor Units / Cents)', () => {
  it('correctly calculates line item amount in minor units (cents)', () => {
    // 2 units at $150.00 (15000 cents) = $300.00 (30000 cents)
    const amount = calculateLineItemAmount(2, 15000);
    expect(amount).toBe(30000);
  });

  it('correctly handles fractional quantities without floating point precision drift', () => {
    // 3.5 hours at $85.50 (8550 cents) = 29925 cents ($299.25)
    const amount = calculateLineItemAmount(3.5, 8550);
    expect(amount).toBe(29925);
  });

  it('rounds fractional cents correctly to nearest integer', () => {
    // 1.333 hours at $100.00 (10000 cents) = 13330 cents
    const amount = calculateLineItemAmount(1.333, 10000);
    expect(amount).toBe(13330);
    expect(Number.isInteger(amount)).toBe(true);
  });

  it('throws an error if quantity or price is negative', () => {
    expect(() => calculateLineItemAmount(-1, 10000)).toThrow('Quantity and unit price must be non-negative');
    expect(() => calculateLineItemAmount(1, -500)).toThrow('Quantity and unit price must be non-negative');
  });

  it('correctly computes estimate subtotal, tax, and total in minor units', () => {
    const lineItems = [
      { quantity: 1, unit_price_cents: 250000 }, // $2,500.00
      { quantity: 40, unit_price_cents: 8500 },  // 40 hrs @ $85 = $3,400.00
      { quantity: 0.5, unit_price_cents: 15000 }, // 0.5 hrs @ $150 = $75.00
    ];
    // Subtotal: 250000 + 340000 + 7500 = 597500 ($5,975.00)
    // Tax: 10% = 59750 cents ($597.50)
    // Total: 657250 cents ($6,572.50)
    const taxCents = 59750;
    const totals = calculateEstimateTotals(lineItems, taxCents);

    expect(totals.subtotal_cents).toBe(597500);
    expect(totals.tax_cents).toBe(59750);
    expect(totals.total_cents).toBe(657250);
  });

  it('avoids classic IEEE-754 binary floating point traps', () => {
    // In IEEE 754 float: 0.1 + 0.2 = 0.30000000000000004
    // With integer cents: 10 cents + 20 cents = exactly 30 cents
    const lineItems = [
      { quantity: 1, unit_price_cents: 10 },
      { quantity: 1, unit_price_cents: 20 },
    ];
    const totals = calculateEstimateTotals(lineItems, 0);
    expect(totals.total_cents).toBe(30);
  });

  it('formats minor units (cents) into human-readable currency strings', () => {
    expect(formatMoney(125000, 'USD')).toBe('$1,250.00');
    expect(formatMoney(0, 'USD')).toBe('$0.00');
    expect(formatMoney(99, 'USD')).toBe('$0.99');
  });
});

describe('Estimate Service - Lifecycle State Machine', () => {
  it('allows valid transitions according to specification', () => {
    // Draft transitions
    expect(isValidTransition('draft', 'sent')).toBe(true);
    expect(isValidTransition('draft', 'rejected')).toBe(true);

    // Sent transitions
    expect(isValidTransition('sent', 'accepted')).toBe(true);
    expect(isValidTransition('sent', 'rejected')).toBe(true);

    // Self transitions (idempotent state)
    expect(isValidTransition('draft', 'draft')).toBe(true);
    expect(isValidTransition('sent', 'sent')).toBe(true);
    expect(isValidTransition('accepted', 'accepted')).toBe(true);
  });

  it('blocks invalid transitions and tampering', () => {
    // Cannot skip sending step directly to accepted
    expect(isValidTransition('draft', 'accepted')).toBe(false);

    // Cannot revert sent proposal back to draft
    expect(isValidTransition('sent', 'draft')).toBe(false);

    // Accepted is a terminal state
    expect(isValidTransition('accepted', 'draft')).toBe(false);
    expect(isValidTransition('accepted', 'sent')).toBe(false);
    expect(isValidTransition('accepted', 'rejected')).toBe(false);

    // Rejected is a terminal state
    expect(isValidTransition('rejected', 'draft')).toBe(false);
    expect(isValidTransition('rejected', 'sent')).toBe(false);
    expect(isValidTransition('rejected', 'accepted')).toBe(false);
  });
});

describe('Estimate Service - Idempotency & Hashing', () => {
  it('generates consistent SHA-256 hashes for identical payloads', () => {
    const payloadA = { accountId: 'acc-1', title: 'Design Review', amount: 1000 };
    const payloadB = { accountId: 'acc-1', title: 'Design Review', amount: 1000 };
    expect(hashPayload(payloadA)).toBe(hashPayload(payloadB));
  });

  it('generates different hashes when payload fields differ', () => {
    const payloadA = { accountId: 'acc-1', title: 'Design Review', amount: 1000 };
    const payloadB = { accountId: 'acc-1', title: 'Design Review', amount: 2000 };
    expect(hashPayload(payloadA)).not.toBe(hashPayload(payloadB));
  });

  it('detects idempotency conflict when same key is reused with different payload', async () => {
    const service = new EstimateService();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            idempotency_key: 'key-123',
            request_hash: 'hash-abc',
            response_status: 201,
            response_body: { estimate: { id: 'est-1' } },
          },
          error: null,
        }),
      }),
    };

    // Case 1: Matching hash -> replay cached
    const replayCheck = await service.checkIdempotency(mockSupabase, 'acc-1', 'key-123', 'hash-abc');
    expect(replayCheck.replay).toBe(true);
    expect(replayCheck.conflict).toBeFalsy();

    // Case 2: Different hash -> conflict detected
    const conflictCheck = await service.checkIdempotency(mockSupabase, 'acc-1', 'key-123', 'different-hash');
    expect(conflictCheck.conflict).toBe(true);
    expect(conflictCheck.replay).toBe(false);
  });
});

describe('Estimate Service - Tenancy Boundaries & Integrity', () => {
  it('generates unique estimate numbers with year prefix', () => {
    const num1 = generateEstimateNumber();
    const num2 = generateEstimateNumber();
    const currentYear = new Date().getFullYear().toString();

    expect(num1).toMatch(new RegExp(`^EST-${currentYear}-[0-9A-F]{6}$`));
    expect(num2).toMatch(new RegExp(`^EST-${currentYear}-[0-9A-F]{6}$`));
    expect(num1).not.toBe(num2);
  });

  it('blocks cross-account project linking during creation', async () => {
    const service = new EstimateService();
    // Supabase mock returns project belonging to a DIFFERENT account
    const mockSupabase = {
      from: vi.fn().mockImplementation((table) => {
        if (table === 'projects') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((col, val) => {
              return {
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), // Not found in this account
                }),
              };
            }),
          };
        }
        return { insert: vi.fn().mockReturnThis() };
      }),
    };

    await expect(
      service.createEstimate(
        mockSupabase,
        'account-tenant-A',
        {
          title: 'Project Estimate',
          project_id: 'project-belonging-to-tenant-B',
          line_items: [{ description: 'Work', quantity: 1, unit_price_cents: 1000 }],
        },
        'user-1',
      ),
    ).rejects.toThrow('Tenancy violation: Specified project does not belong to this account');
  });

  it('prevents soft-deleting accepted estimates to protect financial auditability', async () => {
    const service = new EstimateService();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: 'est-123',
            account_id: 'acc-1',
            status: 'accepted',
            total_cents: 500000,
          },
          error: null,
        }),
      }),
    };

    await expect(
      service.softDeleteEstimate(mockSupabase, 'acc-1', 'est-123'),
    ).rejects.toThrow('Cannot delete an accepted estimate');
  });
});
