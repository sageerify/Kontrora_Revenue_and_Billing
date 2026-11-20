'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  FileText,
  Send,
  CheckCircle,
  XCircle,
  Calendar,
  Building,
  Layers,
  Clock,
  Trash2,
  Edit,
  Loader2,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { formatMoney } from '@/lib/estimate-service';
import { Estimate, EstimateStatus } from '@/lib/estimate-types';

interface EstimatePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimate: Estimate | null;
  accountName?: string;
  onActionComplete?: () => void;
  onEdit?: (estimate: Estimate) => void;
  canManage?: boolean;
}

export function EstimatePreviewDialog({
  open,
  onOpenChange,
  estimate,
  accountName,
  onActionComplete,
  onEdit,
  canManage = true,
}: EstimatePreviewDialogProps) {
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  if (!estimate) return null;

  const getStatusBadge = (status: EstimateStatus) => {
    switch (status) {
      case 'draft':
        return (
          <Badge variant="outline" className="border-gray-400 text-gray-700 bg-gray-50 dark:bg-gray-800 dark:text-gray-200">
            Draft
          </Badge>
        );
      case 'sent':
        return (
          <Badge className="bg-blue-500 hover:bg-blue-600 text-white">
            Sent to Client
          </Badge>
        );
      case 'accepted':
        return (
          <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white">
            Accepted
          </Badge>
        );
      case 'rejected':
        return (
          <Badge className="bg-rose-600 hover:bg-rose-700 text-white">
            Rejected
          </Badge>
        );
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const handleStatusTransition = async (targetStatus: EstimateStatus) => {
    setLoadingAction(targetStatus);
    try {
      const res = await fetch(
        `/api/accounts/${estimate.account_id}/estimates/${estimate.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'transition', targetStatus }),
        },
      );

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update status');
      }

      toast.success(
        targetStatus === 'sent'
          ? 'Estimate sent to client'
          : targetStatus === 'accepted'
          ? 'Estimate marked as accepted!'
          : 'Estimate marked as rejected',
      );

      onOpenChange(false);
      if (onActionComplete) onActionComplete();
    } catch (err: any) {
      toast.error(err.message || 'Error updating status');
    } finally {
      setLoadingAction(null);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this draft estimate?')) return;

    setLoadingAction('delete');
    try {
      const res = await fetch(
        `/api/accounts/${estimate.account_id}/estimates/${estimate.id}`,
        {
          method: 'DELETE',
        },
      );

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete estimate');
      }

      toast.success('Estimate deleted');
      onOpenChange(false);
      if (onActionComplete) onActionComplete();
    } catch (err: any) {
      toast.error(err.message || 'Error deleting estimate');
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto max-w-3xl">
        <DialogHeader className="border-b pb-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-muted">
                  {estimate.estimate_number}
                </span>
                {getStatusBadge(estimate.status)}
              </div>
              <DialogTitle className="text-xl font-bold mt-2">
                {estimate.title}
              </DialogTitle>
            </div>
            <div className="text-right">
              <span className="text-xs text-muted-foreground uppercase tracking-wide">
                Total Value
              </span>
              <div className="text-2xl font-black text-primary">
                {formatMoney(estimate.total_cents, estimate.currency)}
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Metadata summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 py-3 text-sm bg-muted/30 rounded-lg p-3">
          <div>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Building className="h-3.5 w-3.5" /> Account
            </span>
            <p className="font-medium mt-0.5">{accountName || 'Client Account'}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Layers className="h-3.5 w-3.5" /> Project
            </span>
            <p className="font-medium mt-0.5">
              {estimate.project?.name || 'General / Unlinked'}
            </p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" /> Created Date
            </span>
            <p className="font-medium mt-0.5">
              {estimate.created_at ? format(new Date(estimate.created_at), 'MMM d, yyyy') : '-'}
            </p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" /> Valid Until
            </span>
            <p className="font-medium mt-0.5">
              {estimate.valid_until ? format(new Date(estimate.valid_until), 'MMM d, yyyy') : 'No Expiry'}
            </p>
          </div>
        </div>

        {estimate.description && (
          <div className="space-y-1">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase">Scope & Description</h4>
            <p className="text-sm text-foreground whitespace-pre-wrap rounded-md bg-muted/20 p-2.5">
              {estimate.description}
            </p>
          </div>
        )}

        {/* Line Items Table */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase">Deliverables & Rates</h4>
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground text-xs uppercase font-medium">
                <tr>
                  <th className="py-2.5 px-3 text-left">Item</th>
                  <th className="py-2.5 px-3 text-right w-20">Qty</th>
                  <th className="py-2.5 px-3 text-right w-28">Rate</th>
                  <th className="py-2.5 px-3 text-right w-32">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {estimate.line_items && estimate.line_items.length > 0 ? (
                  estimate.line_items.map((item, idx) => (
                    <tr key={item.id || idx} className="hover:bg-muted/30">
                      <td className="py-2.5 px-3 font-medium">{item.description}</td>
                      <td className="py-2.5 px-3 text-right">{item.quantity}</td>
                      <td className="py-2.5 px-3 text-right">
                        {formatMoney(item.unit_price_cents, estimate.currency)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-semibold">
                        {formatMoney(item.amount_cents, estimate.currency)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-muted-foreground">
                      No line items recorded
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Totals Section */}
        <div className="flex justify-end pt-2">
          <div className="w-64 space-y-1.5 text-right text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal:</span>
              <span>{formatMoney(estimate.subtotal_cents, estimate.currency)}</span>
            </div>
            {estimate.tax_cents > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Tax:</span>
                <span>{formatMoney(estimate.tax_cents, estimate.currency)}</span>
              </div>
            )}
            <Separator />
            <div className="flex justify-between text-base font-bold text-foreground">
              <span>Total:</span>
              <span className="text-primary">
                {formatMoney(estimate.total_cents, estimate.currency)}
              </span>
            </div>
          </div>
        </div>

        {estimate.notes && (
          <div className="space-y-1 text-xs text-muted-foreground border-t pt-3">
            <span className="font-semibold uppercase tracking-wider">Terms & Conditions</span>
            <p className="whitespace-pre-wrap">{estimate.notes}</p>
          </div>
        )}

        {/* Timestamps */}
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground border-t pt-3">
          {estimate.sent_at && (
            <span>Sent: {format(new Date(estimate.sent_at), 'MMM d, yyyy HH:mm')}</span>
          )}
          {estimate.accepted_at && (
            <span className="text-emerald-600 font-medium">
              Accepted: {format(new Date(estimate.accepted_at), 'MMM d, yyyy HH:mm')}
            </span>
          )}
          {estimate.rejected_at && (
            <span className="text-rose-600 font-medium">
              Rejected: {format(new Date(estimate.rejected_at), 'MMM d, yyyy HH:mm')}
            </span>
          )}
        </div>

        <DialogFooter className="gap-2 border-t pt-4">
          <div className="flex items-center justify-between w-full">
            <div>
              {canManage && estimate.status === 'draft' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDelete}
                  disabled={Boolean(loadingAction)}
                  className="text-destructive hover:bg-destructive/10 gap-1"
                >
                  {loadingAction === 'delete' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  Delete Draft
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>

              {canManage && estimate.status === 'draft' && (
                <>
                  {onEdit && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onOpenChange(false);
                        onEdit(estimate);
                      }}
                      className="gap-1"
                    >
                      <Edit className="h-3.5 w-3.5" />
                      Edit Line Items
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => handleStatusTransition('sent')}
                    disabled={Boolean(loadingAction)}
                    className="gap-1 bg-blue-600 hover:bg-blue-700"
                  >
                    {loadingAction === 'sent' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    Send to Client
                  </Button>
                </>
              )}

              {canManage && estimate.status === 'sent' && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleStatusTransition('rejected')}
                    disabled={Boolean(loadingAction)}
                    className="gap-1 text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                  >
                    {loadingAction === 'rejected' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5" />
                    )}
                    Mark Rejected
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleStatusTransition('accepted')}
                    disabled={Boolean(loadingAction)}
                    className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {loadingAction === 'accepted' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle className="h-3.5 w-3.5" />
                    )}
                    Accept Estimate
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
