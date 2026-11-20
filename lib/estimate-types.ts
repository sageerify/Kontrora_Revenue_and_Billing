/**
 * REVENUE & BILLING: ESTIMATE TYPES
 * Money amounts are strictly kept in minor units (cents / BIGINT)
 * to avoid floating-point rounding issues in multi-tenant financial calculations.
 */

export type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'rejected';

export interface EstimateLineItem {
  id: string;
  estimate_id: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface Estimate {
  id: string;
  account_id: string;
  project_id: string | null;
  estimate_number: string;
  title: string;
  description: string | null;
  status: EstimateStatus;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  idempotency_key: string | null;
  valid_until: string | null;
  notes: string | null;
  created_by: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  // Joins
  line_items?: EstimateLineItem[];
  project?: {
    id: string;
    name: string;
    status: string;
  } | null;
  creator?: {
    id: string;
    name: string;
    email: string;
  } | null;
}

export interface CreateLineItemInput {
  description: string;
  quantity: number;
  unit_price_cents: number;
  order_index?: number;
}

export interface CreateEstimateInput {
  title: string;
  description?: string | null;
  project_id?: string | null;
  currency?: string;
  tax_cents?: number;
  valid_until?: string | null;
  notes?: string | null;
  line_items: CreateLineItemInput[];
}

export interface UpdateEstimateInput {
  title?: string;
  description?: string | null;
  project_id?: string | null;
  currency?: string;
  tax_cents?: number;
  valid_until?: string | null;
  notes?: string | null;
  line_items?: CreateLineItemInput[];
}

export interface EstimateFilterParams {
  status?: EstimateStatus;
  project_id?: string;
  search?: string;
  page?: number;
  limit?: number;
  sort_by?: 'created_at' | 'total_cents' | 'estimate_number' | 'valid_until';
  sort_order?: 'asc' | 'desc';
}

export interface PaginatedEstimates {
  estimates: Estimate[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    total_pages: number;
  };
  metrics: {
    total_draft_cents: number;
    total_sent_cents: number;
    total_accepted_cents: number;
    total_rejected_cents: number;
    total_value_cents: number;
  };
}
