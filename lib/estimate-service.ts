/**
 * REVENUE & BILLING: ESTIMATE SERVICE
 * Handles money arithmetic in minor units (cents), state machine transitions,
 * idempotency deduplication, and account boundary enforcement.
 */

import crypto from 'crypto';
import {
  Estimate,
  EstimateStatus,
  EstimateLineItem,
  CreateEstimateInput,
  UpdateEstimateInput,
  EstimateFilterParams,
  PaginatedEstimates,
} from './estimate-types';
import { logger } from './debug-logger';

// Finite State Machine allowed transitions
export const ESTIMATE_LIFECYCLE_TRANSITIONS: Record<EstimateStatus, EstimateStatus[]> = {
  draft: ['sent', 'rejected'],
  sent: ['accepted', 'rejected'],
  accepted: [], // Terminal state
  rejected: [], // Terminal state
};

/**
 * Validates whether a lifecycle transition is allowed
 */
export function isValidTransition(from: EstimateStatus, to: EstimateStatus): boolean {
  if (from === to) return true;
  const allowed = ESTIMATE_LIFECYCLE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Money-correct arithmetic: calculates a line item's amount in minor units (cents)
 */
export function calculateLineItemAmount(quantity: number, unitPriceCents: number): number {
  if (quantity < 0 || unitPriceCents < 0) {
    throw new Error('Quantity and unit price must be non-negative');
  }
  // Integer arithmetic: Round to nearest cent
  return Math.round(Number(quantity) * Number(unitPriceCents));
}

/**
 * Money-correct arithmetic: calculates subtotal, tax, and total in minor units (cents)
 */
export function calculateEstimateTotals(
  lineItems: Array<{ quantity: number; unit_price_cents: number }>,
  taxCents: number = 0,
): { subtotal_cents: number; tax_cents: number; total_cents: number } {
  if (taxCents < 0) {
    throw new Error('Tax must be non-negative');
  }

  const subtotal_cents = lineItems.reduce((acc, item) => {
    return acc + calculateLineItemAmount(item.quantity, item.unit_price_cents);
  }, 0);

  const total_cents = subtotal_cents + Math.round(taxCents);

  return {
    subtotal_cents,
    tax_cents: Math.round(taxCents),
    total_cents,
  };
}

/**
 * Generates a SHA-256 hash of a payload for idempotency verification
 */
export function hashPayload(payload: unknown): string {
  const jsonStr = JSON.stringify(payload || {});
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

/**
 * Formats minor units (cents) into user-facing currency string ($1,234.56)
 */
export function formatMoney(cents: number, currency = 'USD'): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(dollars);
}

/**
 * Generates an estimate number, e.g. EST-2026-A1B2
 */
export function generateEstimateNumber(): string {
  const year = new Date().getFullYear();
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `EST-${year}-${randomSuffix}`;
}

export class EstimateService {
  /**
   * List estimates for an account with server-side filters and metrics
   */
  async listEstimates(
    supabase: any,
    accountId: string,
    params: EstimateFilterParams = {},
  ): Promise<PaginatedEstimates> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('estimates')
      .select(
        `
        *,
        project:projects(id, name, status),
        creator:user_profiles!created_by(id, name, email),
        line_items:estimate_line_items(id, description, quantity, unit_price_cents, amount_cents, order_index)
      `,
        { count: 'exact' },
      )
      .eq('account_id', accountId)
      .is('deleted_at', null);

    if (params.status) {
      query = query.eq('status', params.status);
    }

    if (params.project_id) {
      query = query.eq('project_id', params.project_id);
    }

    if (params.search) {
      const term = `%${params.search}%`;
      query = query.or(`title.ilike.${term},estimate_number.ilike.${term}`);
    }

    const sortBy = params.sort_by || 'created_at';
    const sortOrder = params.sort_order || 'desc';
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });
    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) {
      logger.error('Error fetching estimates', { accountId, params }, error);
      throw new Error(`Failed to list estimates: ${error.message}`);
    }

    // Fetch account-level metrics for financial overview
    const { data: allEstimates } = await supabase
      .from('estimates')
      .select('status, total_cents')
      .eq('account_id', accountId)
      .is('deleted_at', null);

    const metrics = (allEstimates || []).reduce(
      (acc: any, est: any) => {
        const val = Number(est.total_cents) || 0;
        acc.total_value_cents += val;
        if (est.status === 'draft') acc.total_draft_cents += val;
        if (est.status === 'sent') acc.total_sent_cents += val;
        if (est.status === 'accepted') acc.total_accepted_cents += val;
        if (est.status === 'rejected') acc.total_rejected_cents += val;
        return acc;
      },
      {
        total_draft_cents: 0,
        total_sent_cents: 0,
        total_accepted_cents: 0,
        total_rejected_cents: 0,
        total_value_cents: 0,
      },
    );

    const total = count || 0;
    return {
      estimates: (data || []) as Estimate[],
      pagination: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit) || 1,
      },
      metrics,
    };
  }

  /**
   * Get an estimate by ID, strictly enforcing account boundary
   */
  async getEstimateById(
    supabase: any,
    accountId: string,
    estimateId: string,
  ): Promise<Estimate | null> {
    const { data, error } = await supabase
      .from('estimates')
      .select(
        `
        *,
        project:projects(id, name, status),
        creator:user_profiles!created_by(id, name, email),
        line_items:estimate_line_items(id, description, quantity, unit_price_cents, amount_cents, order_index)
      `,
      )
      .eq('id', estimateId)
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      logger.error('Error getting estimate by id', { accountId, estimateId }, error);
      throw new Error(`Failed to get estimate: ${error.message}`);
    }

    if (data?.line_items) {
      data.line_items.sort((a: EstimateLineItem, b: EstimateLineItem) => a.order_index - b.order_index);
    }

    return (data as Estimate) || null;
  }

  /**
   * Check idempotency cache for previous response
   */
  async checkIdempotency(
    supabase: any,
    accountId: string,
    key: string,
    requestHash: string,
  ): Promise<{ match: boolean; replay: boolean; record?: any; conflict?: boolean }> {
    const { data, error } = await supabase
      .from('idempotency_records')
      .select('*')
      .eq('account_id', accountId)
      .eq('idempotency_key', key)
      .maybeSingle();

    if (error || !data) {
      return { match: false, replay: false };
    }

    // Check if payload matches
    if (data.request_hash !== requestHash) {
      return { match: false, replay: false, conflict: true };
    }

    return { match: true, replay: true, record: data };
  }

  /**
   * Save an idempotency response record
   */
  async recordIdempotency(
    supabase: any,
    accountId: string,
    key: string,
    requestHash: string,
    status: number,
    body: any,
    resourceId?: string,
  ): Promise<void> {
    try {
      await supabase.from('idempotency_records').upsert(
        {
          account_id: accountId,
          idempotency_key: key,
          request_hash: requestHash,
          response_status: status,
          response_body: body,
          resource_id: resourceId || null,
        },
        { onConflict: 'account_id,idempotency_key' },
      );
    } catch (err) {
      logger.warn('Failed to record idempotency', { accountId, key }, err as Error);
    }
  }

  /**
   * Create an estimate with line items
   */
  async createEstimate(
    supabase: any,
    accountId: string,
    input: CreateEstimateInput,
    userId: string,
    idempotencyKey?: string | null,
  ): Promise<Estimate> {
    // 1. Account boundary validation for optional project_id
    if (input.project_id) {
      const { data: project, error: projErr } = await supabase
        .from('projects')
        .select('id, account_id')
        .eq('id', input.project_id)
        .eq('account_id', accountId)
        .maybeSingle();

      if (projErr || !project) {
        throw new Error('Tenancy violation: Specified project does not belong to this account');
      }
    }

    // 2. Validate line items
    if (!input.line_items || input.line_items.length === 0) {
      throw new Error('Estimate must contain at least one line item');
    }

    // 3. Compute money-correct totals in minor units
    const { subtotal_cents, tax_cents, total_cents } = calculateEstimateTotals(
      input.line_items,
      input.tax_cents || 0,
    );

    const estimateNumber = generateEstimateNumber();

    // 4. Insert estimate record
    const { data: estimate, error: estErr } = await supabase
      .from('estimates')
      .insert({
        account_id: accountId,
        project_id: input.project_id || null,
        estimate_number: estimateNumber,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        status: 'draft',
        currency: input.currency?.toUpperCase() || 'USD',
        subtotal_cents,
        tax_cents,
        total_cents,
        idempotency_key: idempotencyKey || null,
        valid_until: input.valid_until || null,
        notes: input.notes?.trim() || null,
        created_by: userId,
      })
      .select()
      .single();

    if (estErr || !estimate) {
      logger.error('Failed to create estimate header', { accountId }, estErr);
      throw new Error(`Failed to create estimate: ${estErr?.message}`);
    }

    // 5. Insert line items
    const lineItemRows = input.line_items.map((item, index) => {
      const amount_cents = calculateLineItemAmount(item.quantity, item.unit_price_cents);
      return {
        estimate_id: estimate.id,
        description: item.description.trim(),
        quantity: item.quantity,
        unit_price_cents: Math.round(item.unit_price_cents),
        amount_cents,
        order_index: item.order_index ?? index,
      };
    });

    const { data: insertedItems, error: itemsErr } = await supabase
      .from('estimate_line_items')
      .insert(lineItemRows)
      .select();

    if (itemsErr) {
      logger.error('Failed to insert estimate line items', { estimateId: estimate.id }, itemsErr);
      // Clean up orphaned estimate header
      await supabase.from('estimates').delete().eq('id', estimate.id);
      throw new Error(`Failed to insert line items: ${itemsErr.message}`);
    }

    estimate.line_items = insertedItems;
    return estimate as Estimate;
  }

  /**
   * Update draft estimate
   */
  async updateEstimate(
    supabase: any,
    accountId: string,
    estimateId: string,
    input: UpdateEstimateInput,
    _userId: string,
  ): Promise<Estimate> {
    const existing = await this.getEstimateById(supabase, accountId, estimateId);
    if (!existing) {
      throw new Error('Estimate not found');
    }

    if (existing.status !== 'draft') {
      throw new Error(`Cannot modify estimate in '${existing.status}' status. Only drafts can be modified.`);
    }

    // Validate project tenancy
    if (input.project_id) {
      const { data: project } = await supabase
        .from('projects')
        .select('id')
        .eq('id', input.project_id)
        .eq('account_id', accountId)
        .maybeSingle();

      if (!project) {
        throw new Error('Tenancy violation: Project does not belong to this account');
      }
    }

    // Recompute totals if line items provided
    let subtotal_cents = existing.subtotal_cents;
    let tax_cents = input.tax_cents !== undefined ? input.tax_cents : existing.tax_cents;
    let total_cents = existing.total_cents;

    if (input.line_items && input.line_items.length > 0) {
      const computed = calculateEstimateTotals(input.line_items, tax_cents);
      subtotal_cents = computed.subtotal_cents;
      tax_cents = computed.tax_cents;
      total_cents = computed.total_cents;

      // Replace line items
      await supabase.from('estimate_line_items').delete().eq('estimate_id', estimateId);

      const lineItemRows = input.line_items.map((item, index) => ({
        estimate_id: estimateId,
        description: item.description.trim(),
        quantity: item.quantity,
        unit_price_cents: Math.round(item.unit_price_cents),
        amount_cents: calculateLineItemAmount(item.quantity, item.unit_price_cents),
        order_index: item.order_index ?? index,
      }));

      await supabase.from('estimate_line_items').insert(lineItemRows);
    }

    const updates: any = {
      subtotal_cents,
      tax_cents,
      total_cents,
      updated_at: new Date().toISOString(),
    };

    if (input.title !== undefined) updates.title = input.title.trim();
    if (input.description !== undefined) updates.description = input.description?.trim() || null;
    if (input.project_id !== undefined) updates.project_id = input.project_id;
    if (input.currency !== undefined) updates.currency = input.currency.toUpperCase();
    if (input.valid_until !== undefined) updates.valid_until = input.valid_until;
    if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;

    const { data: updated, error } = await supabase
      .from('estimates')
      .update(updates)
      .eq('id', estimateId)
      .eq('account_id', accountId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update estimate: ${error.message}`);
    }

    return (await this.getEstimateById(supabase, accountId, estimateId))!;
  }

  /**
   * Transition estimate lifecycle status: draft -> sent -> accepted | rejected
   */
  async transitionStatus(
    supabase: any,
    accountId: string,
    estimateId: string,
    targetStatus: EstimateStatus,
  ): Promise<Estimate> {
    const existing = await this.getEstimateById(supabase, accountId, estimateId);
    if (!existing) {
      throw new Error('Estimate not found');
    }

    if (!isValidTransition(existing.status, targetStatus)) {
      throw new Error(
        `Invalid lifecycle transition: Cannot move from '${existing.status}' to '${targetStatus}'. Allowed: ${ESTIMATE_LIFECYCLE_TRANSITIONS[existing.status].join(', ') || 'none'}`,
      );
    }

    const updates: any = {
      status: targetStatus,
      updated_at: new Date().toISOString(),
    };

    if (targetStatus === 'sent' && !existing.sent_at) {
      updates.sent_at = new Date().toISOString();
    } else if (targetStatus === 'accepted' && !existing.accepted_at) {
      updates.accepted_at = new Date().toISOString();
    } else if (targetStatus === 'rejected' && !existing.rejected_at) {
      updates.rejected_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('estimates')
      .update(updates)
      .eq('id', estimateId)
      .eq('account_id', accountId);

    if (error) {
      throw new Error(`Failed to transition estimate: ${error.message}`);
    }

    return (await this.getEstimateById(supabase, accountId, estimateId))!;
  }

  /**
   * Soft delete estimate (no hard deletes)
   */
  async softDeleteEstimate(
    supabase: any,
    accountId: string,
    estimateId: string,
  ): Promise<boolean> {
    const existing = await this.getEstimateById(supabase, accountId, estimateId);
    if (!existing) {
      throw new Error('Estimate not found');
    }

    if (existing.status === 'accepted') {
      throw new Error('Cannot delete an accepted estimate. Accepted financial records must be preserved for auditability.');
    }

    const { error } = await supabase
      .from('estimates')
      .update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', estimateId)
      .eq('account_id', accountId);

    if (error) {
      throw new Error(`Failed to soft-delete estimate: ${error.message}`);
    }

    return true;
  }
}

export const estimateService = new EstimateService();
