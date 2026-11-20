import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient } from '@/lib/supabase-server';
import { requireAuthAndPermission, handleGuardError } from '@/lib/server-guards';
import { Permission } from '@/lib/permissions';
import { updateEstimateSchema, transitionEstimateSchema } from '@/lib/validation-schemas';
import { isValidUUID } from '@/lib/validation-helpers';
import { estimateService } from '@/lib/estimate-service';
import { logger } from '@/lib/debug-logger';
import { EstimateStatus } from '@/lib/estimate-types';

interface RouteParams {
  params: Promise<{
    accountId: string;
    id: string;
  }>;
}

/**
 * GET /api/accounts/[accountId]/estimates/[id]
 * Fetch single estimate with line items
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { accountId, id } = await params;

    if (!isValidUUID(accountId) || !isValidUUID(id)) {
      return NextResponse.json({ error: 'Invalid ID format' }, { status: 400 });
    }

    // Require VIEW_ESTIMATES permission under this account context
    await requireAuthAndPermission(Permission.VIEW_ESTIMATES, { accountId }, request);

    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase client not available' }, { status: 500 });
    }

    const estimate = await estimateService.getEstimateById(supabase, accountId, id);
    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }

    return NextResponse.json({ estimate });
  } catch (error: unknown) {
    logger.error('Error in GET /api/accounts/[accountId]/estimates/[id]', {}, error as Error);
    return handleGuardError(error);
  }
}

/**
 * PATCH /api/accounts/[accountId]/estimates/[id]
 * Update estimate draft or transition lifecycle status
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { accountId, id } = await params;

    if (!isValidUUID(accountId) || !isValidUUID(id)) {
      return NextResponse.json({ error: 'Invalid ID format' }, { status: 400 });
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

    // Check if this is a lifecycle transition request
    if (body.action === 'transition' || (body.status && Object.keys(body).length <= 2)) {
      const transitionValidation = transitionEstimateSchema.safeParse({
        status: body.targetStatus || body.status,
      });

      if (!transitionValidation.success) {
        return NextResponse.json(
          { error: 'Invalid target status', details: transitionValidation.error.format() },
          { status: 400 },
        );
      }

      const updated = await estimateService.transitionStatus(
        supabase,
        accountId,
        id,
        transitionValidation.data.status as EstimateStatus,
      );

      return NextResponse.json({ estimate: updated });
    }

    // Standard draft update
    const validation = updateEstimateSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.format() },
        { status: 400 },
      );
    }

    const updated = await estimateService.updateEstimate(
      supabase,
      accountId,
      id,
      validation.data,
      user.id,
    );

    return NextResponse.json({ estimate: updated });
  } catch (error: any) {
    logger.error('Error in PATCH /api/accounts/[accountId]/estimates/[id]', {}, error);
    if (
      error?.message?.includes('Invalid lifecycle transition') ||
      error?.message?.includes('Cannot modify') ||
      error?.message?.includes('Tenancy violation')
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error?.message === 'Estimate not found') {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return handleGuardError(error);
  }
}

/**
 * DELETE /api/accounts/[accountId]/estimates/[id]
 * Soft delete estimate (no hard deletes)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { accountId, id } = await params;

    if (!isValidUUID(accountId) || !isValidUUID(id)) {
      return NextResponse.json({ error: 'Invalid ID format' }, { status: 400 });
    }

    // Require MANAGE_ESTIMATES permission under this account context
    await requireAuthAndPermission(Permission.MANAGE_ESTIMATES, { accountId }, request);

    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase client not available' }, { status: 500 });
    }

    await estimateService.softDeleteEstimate(supabase, accountId, id);

    return NextResponse.json({ success: true, message: 'Estimate deleted' });
  } catch (error: any) {
    logger.error('Error in DELETE /api/accounts/[accountId]/estimates/[id]', {}, error);
    if (error?.message?.includes('Cannot delete an accepted estimate')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error?.message === 'Estimate not found') {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return handleGuardError(error);
  }
}
