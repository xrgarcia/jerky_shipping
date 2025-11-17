import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Printer, FileText } from "lucide-react";
import type { Order } from "@shared/schema";

interface LineItem {
  id: number;
  name: string;
  quantity: number;
  price: string;
  sku?: string;
  product_id?: number;
  variant_id?: number;
}

interface ShippingAddress {
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
}

export default function OrderDetail() {
  const [, params] = useRoute("/orders/:id");
  const orderId = params?.id;

  const { data: orderData, isLoading } = useQuery<{ order: Order }>({
    queryKey: ["/api/orders", orderId],
    enabled: !!orderId,
  });

  const order = orderData?.order;

  const handlePrint = () => {
    window.print();
  };

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <p className="text-lg text-muted-foreground">Loading order...</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <Card>
          <CardContent className="py-12 text-center">
            <h2 className="text-2xl font-semibold mb-2">Order not found</h2>
            <p className="text-muted-foreground mb-6">
              The order you're looking for doesn't exist.
            </p>
            <Link href="/orders">
              <Button>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Orders
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const lineItems = (order.lineItems as LineItem[]) || [];
  const shippingAddress = (order.shippingAddress as ShippingAddress) || {};

  return (
    <>
      <div className="print:hidden max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <Link href="/orders">
            <Button variant="outline" data-testid="button-back">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Orders
            </Button>
          </Link>
          <div className="flex gap-2">
            <Button
              data-testid="button-print-label"
              onClick={handlePrint}
              variant="outline"
              size="lg"
            >
              <FileText className="mr-2 h-5 w-5" />
              Print Label
            </Button>
            <Button
              data-testid="button-print-packing-slip"
              onClick={handlePrint}
              size="lg"
            >
              <Printer className="mr-2 h-5 w-5" />
              Print Packing Slip
            </Button>
          </div>
        </div>

        <div>
          <h1 className="text-5xl font-mono font-bold mb-2">#{order.orderNumber}</h1>
          <div className="flex items-center gap-3">
            <Badge variant={order.fulfillmentStatus === "fulfilled" ? "default" : "outline"}>
              {order.fulfillmentStatus || "Unfulfilled"}
            </Badge>
            <span className="text-lg text-muted-foreground">
              {new Date(order.createdAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-3xl font-semibold">Customer Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Name
              </p>
              <p className="text-2xl font-semibold">{order.customerName}</p>
            </div>
            {order.customerEmail && (
              <div>
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                  Email
                </p>
                <p className="text-xl">{order.customerEmail}</p>
              </div>
            )}
            {order.customerPhone && (
              <div>
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                  Phone
                </p>
                <p className="text-xl">{order.customerPhone}</p>
              </div>
            )}
            {shippingAddress.address1 && (
              <div>
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                  Shipping Address
                </p>
                <div className="text-xl space-y-1">
                  <p>{shippingAddress.address1}</p>
                  {shippingAddress.address2 && <p>{shippingAddress.address2}</p>}
                  <p>
                    {shippingAddress.city}, {shippingAddress.province} {shippingAddress.zip}
                  </p>
                  <p>{shippingAddress.country}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-3xl font-semibold">Products</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              {lineItems.map((item) => (
                <Card key={item.id}>
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <h3 className="text-2xl font-semibold mb-2" data-testid={`text-product-name-${item.id}`}>
                          {item.name}
                        </h3>
                        {item.sku && (
                          <p className="text-lg font-mono text-muted-foreground mb-2">
                            SKU: {item.sku}
                          </p>
                        )}
                        <p className="text-xl text-muted-foreground">
                          ${item.price} each
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="bg-primary text-primary-foreground px-4 py-2 rounded-md">
                          <p className="text-sm font-semibold uppercase tracking-wide">Quantity</p>
                          <p className="text-3xl font-bold" data-testid={`text-quantity-${item.id}`}>
                            {item.quantity}
                          </p>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <p className="text-2xl font-semibold">Total</p>
              <p className="text-4xl font-bold">${order.totalPrice}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="hidden print:block p-8 bg-white text-black">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">PACKING SLIP</h1>
          <p className="text-2xl">Order #{order.orderNumber}</p>
          <p className="text-lg">
            {new Date(order.createdAt).toLocaleDateString()}
          </p>
        </div>

        <div className="mb-8 border-t-2 border-black pt-4">
          <h2 className="text-2xl font-bold mb-4">SHIP TO:</h2>
          <p className="text-xl font-bold">{order.customerName}</p>
          {shippingAddress.address1 && (
            <div className="text-lg mt-2">
              <p>{shippingAddress.address1}</p>
              {shippingAddress.address2 && <p>{shippingAddress.address2}</p>}
              <p>
                {shippingAddress.city}, {shippingAddress.province} {shippingAddress.zip}
              </p>
              <p>{shippingAddress.country}</p>
            </div>
          )}
        </div>

        <div className="mb-8 border-t-2 border-black pt-4">
          <h2 className="text-2xl font-bold mb-4">ITEMS:</h2>
          <table className="w-full text-lg">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="text-left py-2">Product</th>
                <th className="text-left py-2">SKU</th>
                <th className="text-right py-2">Qty</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item) => (
                <tr key={item.id} className="border-b border-gray-300">
                  <td className="py-3">{item.name}</td>
                  <td className="py-3 font-mono">{item.sku || "-"}</td>
                  <td className="py-3 text-right font-bold text-2xl">{item.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t-2 border-black pt-4">
          <p className="text-2xl font-bold">TOTAL: ${order.totalPrice}</p>
        </div>
      </div>
    </>
  );
}
