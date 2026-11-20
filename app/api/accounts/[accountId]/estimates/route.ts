import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient } from '@/lib/supabase-server';
import { requireAuthAndPermission, handleGuardError } from '@/lib/server-guards';
import { Permission } from '@/lib/permissions';
import { createEstimateSchema } from '@/lib/validation-schemas';
import { isValidUUID } from '@/lib/validation-helpers';
import { estimateService, hashPayload } from '@/lib/estimate-service';
import { logger } from '@/lib/debug-logger';
import { EstimateFilterParams, EstimateStatus } from '@/lib/estimate-types';

interface RouteParams {
  params: Promise<{
    accountId: string;
  }>;
}

/**
 * GET /api/accounts/[accountId]/estimates
 * List & filter estimates scoped to account
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { accountId } = await params;

    if (!isValidUUID(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID format' }, { status: 400 });
    }

    // Require VIEW_ESTIMATES permission under this account context
    await requireAuthAndPermission(Permission.VIEW_ESTIMATES, { accountId }, request);

    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase client not available' }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const filterParams: EstimateFilterParams = {
      status: (searchParams.get('status') as EstimateStatus) || undefined,
      project_id: searchParams.get('project_id') || undefined,
      search: searchParams.get('search') || undefined,
      page: searchParams.get('page') ? parseInt(searchParams.get('page')!, 10) : 1,
      limit: searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : 20,
      sort_by: (searchParams.get('sort_by') as any) || 'created_at',
      sort_order: (searchParams.get('sort_order') as any) || 'desc',
    };

    const result = await estimateService.listEstimates(supabase, accountId, filterParams);
    return NextResponse.json(result);
  } catch (error: unknown) {
    logger.error('Error in GET /api/accounts/[accountId]/estimates', {}, error as Error);
    return handleGuardError(error);
  }
}

/**
 * POST /api/accounts/[accountId]/estimates
 * Create draft estimate with line items and Idempotency-Key support
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { accountId } = await params;

    if (!isValidUUID(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID format' }, { status: 400 });
    }

    // Require MANAGE_ESTIMATES permission under this account context
    const user = await requireAuthAndPermission(Permission.MANAGE_ESTIMATES, { accountId }, request);

    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase client not available' }, { status: 500 });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    // Check Idempotency-Key header
    const idempotencyKey = request.headers.get('idempotency-key') || request.headers.get('x-idempotency-key');
    const requestHash = hashPayload({ accountId, body });

    if (idempotencyKey) {
      const cacheCheck = await estimateService.checkIdempotency(
        supabase,
        accountId,
        idempotencyKey,
        requestHash,
      );

      if (cacheCheck.conflict) {
        return NextResponse.json(
          { error: 'Idempotency key reused with different request payload' },
          { status: 409 },
        );
      }

      if (cacheCheck.replay && cacheCheck.record) {
        logger.info('Returning idempotent cached estimate response', { idempotencyKey, accountId });
        return NextResponse.json(cacheCheck.record.response_body, {
          status: cacheCheck.record.response_status,
          headers: {
            'Idempotent-Replay': 'true',
          },
        });
      }
    }

    // Validate payload with Zod
    const validation = createEstimateSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: validation.error.format(),
        },
        { status: 400 },
      );
    }

    const estimate = await estimateService.createEstimate(
      supabase,
      accountId,
      validation.data,
      user.id,
      idempotencyKey,
    );

    const responseData = { estimate };

    // Record idempotency response for safe replay
    if (idempotencyKey) {
      await estimateService.recordIdempotency(
        supabase,
        accountId,
        idempotencyKey,
        requestHash,
        201,
        responseData,
        estimate.id,
      );
    }

    return NextResponse.json(responseData, { status: 201 });
  } catch (error: any) {
    logger.error('Error in POST /api/accounts/[accountId]/estimates', {}, error);
    if (error?.message?.includes('Tenancy violation') || error?.message?.includes('does not belong to this account')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return handleGuardError(error);
  }
}
