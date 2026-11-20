'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DollarSign,
  Plus,
  Search,
  Filter,
  FileText,
  Clock,
  CheckCircle2,
  XCircle,
  Eye,
  RefreshCw,
  TrendingUp,
  Layers,
  ArrowUpDown,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { formatMoney } from '@/lib/estimate-service';
import { Estimate, EstimateStatus, PaginatedEstimates } from '@/lib/estimate-types';
import { EstimateDialog } from './estimate-dialog';
import { EstimatePreviewDialog } from './estimate-preview-dialog';

interface AccountEstimatesProps {
  accountId: string;
  accountName?: string;
  projects?: Array<{ id: string; name: string }>;
  canManage?: boolean;
}

export function AccountEstimates({
  accountId,
  accountName,
  projects = [],
  canManage = true,
}: AccountEstimatesProps) {
  const [data, setData] = useState<PaginatedEstimates | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingEstimate, setEditingEstimate] = useState<Estimate | null>(null);
  const [previewEstimate, setPreviewEstimate] = useState<Estimate | null>(null);

  const fetchEstimates = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (statusFilter !== 'all') query.set('status', statusFilter);
      if (projectFilter !== 'all') query.set('project_id', projectFilter);
      if (search.trim()) query.set('search', search.trim());

      const res = await fetch(`/api/accounts/${accountId}/estimates?${query.toString()}`);
      if (!res.ok) {
        throw new Error('Failed to load estimates');
      }

      const json = await res.json();
      setData(json);
    } catch (err: any) {
      toast.error(err.message || 'Error fetching estimates');
    } finally {
      setLoading(false);
    }
  }, [accountId, statusFilter, projectFilter, search]);

  useEffect(() => {
    fetchEstimates();
  }, [fetchEstimates]);

  const handleEdit = (estimate: Estimate) => {
    setEditingEstimate(estimate);
    setCreateDialogOpen(true);
  };

  const handleCreateNew = () => {
    setEditingEstimate(null);
    setCreateDialogOpen(true);
  };

  const getStatusBadge = (status: EstimateStatus) => {
    switch (status) {
      case 'draft':
        return (
          <Badge variant="outline" className="text-muted-foreground border-gray-300">
            Draft
          </Badge>
        );
      case 'sent':
        return <Badge className="bg-blue-500 hover:bg-blue-600 text-white">Sent</Badge>;
      case 'accepted':
        return (
          <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white">Accepted</Badge>
        );
      case 'rejected':
        return <Badge className="bg-rose-600 hover:bg-rose-700 text-white">Rejected</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const metrics = data?.metrics || {
    total_draft_cents: 0,
    total_sent_cents: 0,
    total_accepted_cents: 0,
    total_rejected_cents: 0,
    total_value_cents: 0,
  };

  return (
    <div className="space-y-6">
      {/* Revenue & Pipeline Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <DollarSign className="h-6 w-6 text-primary" />
            Revenue & Estimates
          </h2>
          <p className="text-sm text-muted-foreground">
            Account-scoped estimates, proposals, and pipeline analytics with money-correct calculations.
          </p>
        </div>

        {canManage && (
          <Button onClick={handleCreateNew} className="gap-1.5 shrink-0">
            <Plus className="h-4 w-4" />
            New Estimate
          </Button>
        )}
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs flex items-center justify-between">
              Total Pipeline Value
              <TrendingUp className="h-3.5 w-3.5 text-primary" />
            </CardDescription>
            <CardTitle className="text-xl font-bold">
              {formatMoney(metrics.total_value_cents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-[11px] text-muted-foreground">Across all lifecycle stages</p>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs flex items-center justify-between">
              Awaiting Approval (Sent)
              <Clock className="h-3.5 w-3.5 text-blue-500" />
            </CardDescription>
            <CardTitle className="text-xl font-bold text-blue-600 dark:text-blue-400">
              {formatMoney(metrics.total_sent_cents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-[11px] text-muted-foreground">Proposals pending client action</p>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs flex items-center justify-between">
              Won Revenue (Accepted)
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            </CardDescription>
            <CardTitle className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
              {formatMoney(metrics.total_accepted_cents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-[11px] text-muted-foreground">Ready for milestone billing</p>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs flex items-center justify-between">
              In Draft
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            </CardDescription>
            <CardTitle className="text-xl font-bold">
              {formatMoney(metrics.total_draft_cents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-[11px] text-muted-foreground">Unsent draft proposals</p>
          </CardContent>
        </Card>
      </div>

      {/* Estimates Table Card */}
      <Card>
        <CardHeader className="p-4 border-b">
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            {/* Search */}
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search estimate number or title..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 text-sm"
              />
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 w-36 text-xs">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="accepted">Accepted</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>

              {projects.length > 0 && (
                <Select value={projectFilter} onValueChange={setProjectFilter}>
                  <SelectTrigger className="h-9 w-40 text-xs">
                    <SelectValue placeholder="Project" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Projects</SelectItem>
                    {projects.map((proj) => (
                      <SelectItem key={proj.id} value={proj.id}>
                        {proj.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <Button
                variant="outline"
                size="icon"
                onClick={fetchEstimates}
                className="h-9 w-9"
                title="Refresh estimates"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {loading && !data ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Loading estimates...
            </div>
          ) : !data?.estimates || data.estimates.length === 0 ? (
            <div className="p-8 text-center space-y-2">
              <FileText className="h-8 w-8 text-muted-foreground mx-auto opacity-50" />
              <p className="text-sm font-medium">No estimates found</p>
              <p className="text-xs text-muted-foreground">
                {statusFilter !== 'all' || search
                  ? 'Try adjusting your search filters.'
                  : 'Create your first estimate to start revenue planning for this account.'}
              </p>
              {canManage && (
                <Button onClick={handleCreateNew} variant="outline" size="sm" className="mt-2">
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Create Estimate
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-medium border-b">
                  <tr>
                    <th className="py-3 px-4 text-left">Estimate #</th>
                    <th className="py-3 px-4 text-left">Title</th>
                    <th className="py-3 px-4 text-left">Project</th>
                    <th className="py-3 px-4 text-left">Status</th>
                    <th className="py-3 px-4 text-right">Total Amount</th>
                    <th className="py-3 px-4 text-left">Valid Until</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.estimates.map((est) => (
                    <tr
                      key={est.id}
                      onClick={() => setPreviewEstimate(est)}
                      className="hover:bg-muted/30 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-mono font-semibold text-xs text-primary">
                        {est.estimate_number}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-foreground">{est.title}</div>
                        {est.description && (
                          <div className="text-xs text-muted-foreground line-clamp-1 max-w-xs">
                            {est.description}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        {est.project ? (
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <Layers className="h-3 w-3" />
                            {est.project.name}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4">{getStatusBadge(est.status)}</td>
                      <td className="py-3 px-4 text-right font-bold text-foreground">
                        {formatMoney(est.total_cents, est.currency)}
                      </td>
                      <td className="py-3 px-4 text-xs text-muted-foreground">
                        {est.valid_until ? format(new Date(est.valid_until), 'MMM d, yyyy') : '—'}
                      </td>
                      <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPreviewEstimate(est)}
                            className="h-8 px-2 text-xs"
                          >
                            <Eye className="h-3.5 w-3.5 mr-1" />
                            View
                          </Button>

                          {canManage && est.status === 'draft' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEdit(est)}
                              className="h-8 px-2 text-xs"
                            >
                              Edit
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create / Edit Dialog */}
      <EstimateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        accountId={accountId}
        projects={projects}
        editEstimate={editingEstimate}
        onEstimateSaved={fetchEstimates}
      />

      {/* Preview Dialog */}
      <EstimatePreviewDialog
        open={Boolean(previewEstimate)}
        onOpenChange={(open) => !open && setPreviewEstimate(null)}
        estimate={previewEstimate}
        accountName={accountName}
        canManage={canManage}
        onActionComplete={fetchEstimates}
        onEdit={(est) => {
          setPreviewEstimate(null);
          handleEdit(est);
        }}
      />
    </div>
  );
}
