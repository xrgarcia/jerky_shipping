import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  Search, 
  Layers, 
  ArrowUpDown, 
  ArrowUp, 
  ArrowDown,
  Package,
  CheckCircle2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

interface FingerprintData {
  id: string;
  signature: string;
  signatureHash: string;
  displayName: string | null;
  totalItems: number;
  collectionCount: number;
  totalWeight: number | null;
  weightUnit: string | null;
  createdAt: string;
  shipmentCount: number;
  packagingTypeId: string | null;
  packagingTypeName: string | null;
  stationType: string | null;
  humanReadableName: string;
  hasPackaging: boolean;
}

interface FingerprintsResponse {
  fingerprints: FingerprintData[];
  stats: {
    total: number;
    assigned: number;
    needsDecision: number;
  };
}

type SortField = "humanReadableName" | "totalItems" | "shipmentCount" | "packagingTypeName" | "createdAt";
type SortDir = "asc" | "desc";

export default function FingerprintsReport() {
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("shipmentCount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [statusFilter, setStatusFilter] = useState<"all" | "assigned" | "unassigned">("all");

  const { data, isLoading } = useQuery<FingerprintsResponse>({
    queryKey: ["/api/fingerprints"],
  });

  const fingerprints = data?.fingerprints || [];
  const stats = data?.stats;

  const filteredAndSortedFingerprints = useMemo(() => {
    let result = [...fingerprints];

    if (search.trim()) {
      const searchLower = search.toLowerCase();
      result = result.filter(fp =>
        fp.humanReadableName.toLowerCase().includes(searchLower) ||
        fp.signatureHash.toLowerCase().includes(searchLower) ||
        (fp.packagingTypeName?.toLowerCase().includes(searchLower))
      );
    }

    if (statusFilter === "assigned") {
      result = result.filter(fp => fp.hasPackaging);
    } else if (statusFilter === "unassigned") {
      result = result.filter(fp => !fp.hasPackaging);
    }

    result.sort((a, b) => {
      let aVal: any;
      let bVal: any;

      switch (sortField) {
        case "humanReadableName":
          aVal = a.humanReadableName.toLowerCase();
          bVal = b.humanReadableName.toLowerCase();
          break;
        case "totalItems":
          aVal = a.totalItems;
          bVal = b.totalItems;
          break;
        case "shipmentCount":
          aVal = a.shipmentCount;
          bVal = b.shipmentCount;
          break;
        case "packagingTypeName":
          aVal = a.packagingTypeName?.toLowerCase() || "";
          bVal = b.packagingTypeName?.toLowerCase() || "";
          break;
        case "createdAt":
          aVal = new Date(a.createdAt).getTime();
          bVal = new Date(b.createdAt).getTime();
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return result;
  }, [fingerprints, search, statusFilter, sortField, sortDir]);

  const totalPages = Math.ceil(filteredAndSortedFingerprints.length / limit);
  const paginatedFingerprints = filteredAndSortedFingerprints.slice(
    (page - 1) * limit,
    page * limit
  );

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
    setPage(1);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-4 w-4 text-muted-foreground" />;
    }
    return sortDir === "asc" 
      ? <ArrowUp className="h-4 w-4" />
      : <ArrowDown className="h-4 w-4" />;
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold font-serif flex items-center gap-2">
            <Layers className="h-6 w-6" />
            Fingerprints Report
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            View all product composition fingerprints and their packaging assignments
          </p>
        </div>
        {stats && (
          <div className="flex items-center gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold">{stats.total}</div>
              <div className="text-xs text-muted-foreground">Total</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{stats.assigned}</div>
              <div className="text-xs text-muted-foreground">Assigned</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-amber-600">{stats.needsDecision}</div>
              <div className="text-xs text-muted-foreground">Unassigned</div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, hash, or packaging type..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
            data-testid="input-fingerprint-search"
          />
        </div>

        <Select value={statusFilter} onValueChange={(v: "all" | "assigned" | "unassigned") => {
          setStatusFilter(v);
          setPage(1);
        }}>
          <SelectTrigger className="w-40" data-testid="select-status-filter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="assigned">Assigned</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
          </SelectContent>
        </Select>

        <Select value={String(limit)} onValueChange={(v) => {
          setLimit(Number(v));
          setPage(1);
        }}>
          <SelectTrigger className="w-24" data-testid="select-limit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10</SelectItem>
            <SelectItem value="25">25</SelectItem>
            <SelectItem value="50">50</SelectItem>
            <SelectItem value="100">100</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[400px]">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 -ml-3 font-semibold"
                  onClick={() => handleSort("humanReadableName")}
                  data-testid="sort-name"
                >
                  Fingerprint
                  <SortIcon field="humanReadableName" />
                </Button>
              </TableHead>
              <TableHead className="w-[100px] text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 font-semibold"
                  onClick={() => handleSort("totalItems")}
                  data-testid="sort-items"
                >
                  Items
                  <SortIcon field="totalItems" />
                </Button>
              </TableHead>
              <TableHead className="w-[120px] text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 font-semibold"
                  onClick={() => handleSort("shipmentCount")}
                  data-testid="sort-shipments"
                >
                  Shipments
                  <SortIcon field="shipmentCount" />
                </Button>
              </TableHead>
              <TableHead className="w-[200px]">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 -ml-3 font-semibold"
                  onClick={() => handleSort("packagingTypeName")}
                  data-testid="sort-packaging"
                >
                  Packaging Type
                  <SortIcon field="packagingTypeName" />
                </Button>
              </TableHead>
              <TableHead className="w-[100px] text-center">Station</TableHead>
              <TableHead className="w-[100px] text-center">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [...Array(10)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-5 w-80" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-12 mx-auto" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16 mx-auto" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16 mx-auto" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-20 mx-auto" /></TableCell>
                </TableRow>
              ))
            ) : paginatedFingerprints.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Package className="h-10 w-10 text-muted-foreground" />
                    <p className="text-muted-foreground">
                      {search || statusFilter !== "all" 
                        ? "No fingerprints match your filters" 
                        : "No fingerprints found"}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              paginatedFingerprints.map((fp) => (
                <TableRow key={fp.id} data-testid={`fingerprint-row-${fp.id}`}>
                  <TableCell>
                    <div className="max-w-[380px]">
                      <div className="font-medium truncate" title={fp.humanReadableName}>
                        {fp.humanReadableName}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono truncate">
                        {fp.signatureHash}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="secondary">{fp.totalItems}</Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline">{fp.shipmentCount.toLocaleString()}</Badge>
                  </TableCell>
                  <TableCell>
                    {fp.packagingTypeName ? (
                      <span className="font-medium">{fp.packagingTypeName}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {fp.stationType ? (
                      <Badge 
                        variant="outline" 
                        className={fp.stationType === "boxing" 
                          ? "border-blue-500 text-blue-600" 
                          : "border-amber-500 text-amber-600"}
                      >
                        {fp.stationType}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {fp.hasPackaging ? (
                      <Badge className="bg-green-600 text-white">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Assigned
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-amber-500 text-amber-600">
                        <AlertCircle className="h-3 w-3 mr-1" />
                        Unassigned
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-muted-foreground">
            Showing {((page - 1) * limit) + 1} to {Math.min(page * limit, filteredAndSortedFingerprints.length)} of {filteredAndSortedFingerprints.length} fingerprints
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                let pageNum: number;
                if (totalPages <= 5) {
                  pageNum = i + 1;
                } else if (page <= 3) {
                  pageNum = i + 1;
                } else if (page >= totalPages - 2) {
                  pageNum = totalPages - 4 + i;
                } else {
                  pageNum = page - 2 + i;
                }
                return (
                  <Button
                    key={pageNum}
                    variant={page === pageNum ? "default" : "outline"}
                    size="sm"
                    className="w-9"
                    onClick={() => setPage(pageNum)}
                    data-testid={`button-page-${pageNum}`}
                  >
                    {pageNum}
                  </Button>
                );
              })}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              data-testid="button-next-page"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
