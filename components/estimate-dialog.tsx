'use client';

import React, { useState, useEffect, useId } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Trash2, Calculator, AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@/lib/estimate-service';

export interface LineItemFormItem {
  id?: string;
  description: string;
  quantity: number;
  unit_price: number; // in dollars for user input
}

interface EstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  projects?: Array<{ id: string; name: string }>;
  onEstimateSaved?: () => void;
  editEstimate?: any;
}

export function EstimateDialog({
  open,
  onOpenChange,
  accountId,
  projects = [],
  onEstimateSaved,
  editEstimate,
}: EstimateDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<string>('none');
  const [currency, setCurrency] = useState('USD');
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [taxRate, setTaxRate] = useState<number>(0); // Percentage, e.g. 10%
  const [submitting, setSubmitting] = useState(false);

  const [lineItems, setLineItems] = useState<LineItemFormItem[]>([
    { description: 'Consulting & Implementation', quantity: 1, unit_price: 150 },
  ]);

  useEffect(() => {
    if (editEstimate) {
      setTitle(editEstimate.title || '');
      setDescription(editEstimate.description || '');
      setProjectId(editEstimate.project_id || 'none');
      setCurrency(editEstimate.currency || 'USD');
      setValidUntil(editEstimate.valid_until ? editEstimate.valid_until.split('T')[0] : '');
      setNotes(editEstimate.notes || '');

      if (editEstimate.line_items && editEstimate.line_items.length > 0) {
        setLineItems(
          editEstimate.line_items.map((item: any) => ({
            id: item.id,
            description: item.description,
            quantity: Number(item.quantity) || 1,
            unit_price: (Number(item.unit_price_cents) || 0) / 100,
          })),
        );
      }
    } else {
      // Default reset
      setTitle('');
      setDescription('');
      setProjectId('none');
      setCurrency('USD');
      setValidUntil('');
      setNotes('');
      setTaxRate(0);
      setLineItems([
        { description: 'Initial Discovery & Architecture', quantity: 1, unit_price: 2500 },
        { description: 'Engineering Implementation', quantity: 40, unit_price: 85 },
      ]);
    }
  }, [editEstimate, open]);

  // Minor unit calculation
  const subtotalCents = lineItems.reduce((acc, item) => {
    const qty = Math.max(0, Number(item.quantity) || 0);
    const unitPriceCents = Math.max(0, Math.round((Number(item.unit_price) || 0) * 100));
    return acc + Math.round(qty * unitPriceCents);
  }, 0);

  const taxCents = Math.round(subtotalCents * (Math.max(0, Number(taxRate) || 0) / 100));
  const totalCents = subtotalCents + taxCents;

  const handleAddLineItem = () => {
    setLineItems((prev) => [
      ...prev,
      { description: '', quantity: 1, unit_price: 100 },
    ]);
  };

  const handleRemoveLineItem = (index: number) => {
    if (lineItems.length <= 1) {
      toast.error('An estimate must have at least one line item');
      return;
    }
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleLineItemChange = (index: number, field: keyof LineItemFormItem, value: any) => {
    setLineItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      toast.error('Please enter an estimate title');
      return;
    }

    if (lineItems.length === 0) {
      toast.error('At least one line item is required');
      return;
    }

    for (let i = 0; i < lineItems.length; i++) {
      if (!lineItems[i].description.trim()) {
        toast.error(`Line item #${i + 1} requires a description`);
        return;
      }
      if (lineItems[i].quantity <= 0) {
        toast.error(`Line item #${i + 1} quantity must be greater than 0`);
        return;
      }
      if (lineItems[i].unit_price < 0) {
        toast.error(`Line item #${i + 1} price cannot be negative`);
        return;
      }
    }

    setSubmitting(true);

    try {
      // Generate client-side UUID for idempotency on create
      const idempotencyKey = crypto.randomUUID();

      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        project_id: projectId === 'none' ? null : projectId,
        currency,
        tax_cents: taxCents,
        valid_until: validUntil || null,
        notes: notes.trim() || null,
        line_items: lineItems.map((item, idx) => ({
          description: item.description.trim(),
          quantity: Number(item.quantity),
          unit_price_cents: Math.round(Number(item.unit_price) * 100),
          order_index: idx,
        })),
      };

      const isEdit = Boolean(editEstimate?.id);
      const url = isEdit
        ? `/api/accounts/${accountId}/estimates/${editEstimate.id}`
        : `/api/accounts/${accountId}/estimates`;

      const method = isEdit ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(isEdit ? {} : { 'Idempotency-Key': idempotencyKey }),
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to save estimate');
      }

      toast.success(
        isEdit
          ? 'Estimate updated successfully'
          : `Estimate ${data.estimate?.estimate_number || ''} created successfully!`,
      );

      onOpenChange(false);
      if (onEstimateSaved) onEstimateSaved();
    } catch (err: any) {
      toast.error(err.message || 'Error saving estimate');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-primary" />
            {editEstimate ? 'Edit Draft Estimate' : 'Create New Estimate'}
          </DialogTitle>
          <DialogDescription>
            Build a client estimate with transparent, money-correct line item breakdown.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 pt-2">
          {/* Header Details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="estimate-title">Estimate Title *</Label>
              <Input
                id="estimate-title"
                placeholder="e.g. Q4 Modernization & Migration"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="estimate-project">Associated Project (Optional)</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="estimate-project">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific project</SelectItem>
                  {projects.map((proj) => (
                    <SelectItem key={proj.id} value={proj.id}>
                      {proj.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="estimate-currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="estimate-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD ($) - US Dollar</SelectItem>
                  <SelectItem value="EUR">EUR (€) - Euro</SelectItem>
                  <SelectItem value="GBP">GBP (£) - British Pound</SelectItem>
                  <SelectItem value="CAD">CAD ($) - Canadian Dollar</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="estimate-valid-until">Valid Until Date</Label>
              <Input
                id="estimate-valid-until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="estimate-description">Scope Overview / Description</Label>
            <Textarea
              id="estimate-description"
              placeholder="High-level description of deliverables and goals..."
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Line Items Editor */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <div>
                <h4 className="text-sm font-semibold">Line Items</h4>
                <p className="text-xs text-muted-foreground">
                  All unit prices and totals are computed with integer minor-unit math.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddLineItem}
                className="gap-1 h-8 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Item
              </Button>
            </div>

            <div className="space-y-2">
              {lineItems.map((item, index) => {
                const itemTotalDollars = (
                  (Number(item.quantity) || 0) * (Number(item.unit_price) || 0)
                ).toFixed(2);

                return (
                  <div
                    key={index}
                    className="flex flex-col md:flex-row items-start md:items-center gap-2 p-3 bg-muted/40 rounded-lg border text-sm"
                  >
                    <div className="flex-1 w-full md:w-auto">
                      <Input
                        placeholder="Description of deliverable or service"
                        value={item.description}
                        onChange={(e) =>
                          handleLineItemChange(index, 'description', e.target.value)
                        }
                        className="h-9"
                        required
                      />
                    </div>

                    <div className="flex items-center gap-2 w-full md:w-auto">
                      <div className="w-24">
                        <Input
                          type="number"
                          step="0.5"
                          min="0.1"
                          placeholder="Qty"
                          value={item.quantity}
                          onChange={(e) =>
                            handleLineItemChange(
                              index,
                              'quantity',
                              parseFloat(e.target.value) || 0,
                            )
                          }
                          className="h-9 text-right"
                          title="Quantity (hours or units)"
                          required
                        />
                      </div>

                      <div className="w-28 relative">
                        <span className="absolute left-2.5 top-2 text-xs text-muted-foreground">
                          $
                        </span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="Price"
                          value={item.unit_price}
                          onChange={(e) =>
                            handleLineItemChange(
                              index,
                              'unit_price',
                              parseFloat(e.target.value) || 0,
                            )
                          }
                          className="h-9 pl-6 text-right"
                          title="Unit price"
                          required
                        />
                      </div>

                      <div className="w-28 text-right font-medium pr-1">
                        ${itemTotalDollars}
                      </div>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveLineItem(index)}
                        className="h-9 w-9 text-muted-foreground hover:text-destructive shrink-0"
                        title="Remove item"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Totals Summary */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 p-4 rounded-lg bg-card border">
            <div className="w-full md:w-72 space-y-2">
              <Label htmlFor="tax-rate" className="text-xs">
                Estimated Tax Rate (%)
              </Label>
              <Input
                id="tax-rate"
                type="number"
                min="0"
                max="100"
                step="0.1"
                placeholder="0%"
                value={taxRate}
                onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Tax is calculated on subtotal and stored as integer cents.
              </p>
            </div>

            <div className="w-full md:w-64 space-y-1.5 text-right border-t md:border-t-0 pt-2 md:pt-0">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Subtotal:</span>
                <span>{formatMoney(subtotalCents, currency)}</span>
              </div>
              {taxCents > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Tax ({taxRate}%):</span>
                  <span>{formatMoney(taxCents, currency)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold text-foreground border-t pt-1.5">
                <span>Total:</span>
                <span className="text-primary">{formatMoney(totalCents, currency)}</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="estimate-notes">Client Terms & Notes</Label>
            <Textarea
              id="estimate-notes"
              placeholder="e.g. Net 30 payment terms. 50% deposit required upon acceptance."
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="min-w-28">
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : editEstimate ? (
                'Update Draft'
              ) : (
                'Save as Draft'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
