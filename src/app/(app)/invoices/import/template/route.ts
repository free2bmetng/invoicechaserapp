// The blank CSV template: the exact headers the importer reads, and nothing else. It holds no user
// data, so it needs no session. It has no example row, so an unedited template can never import anything.
import { INVOICE_CSV_HEADERS } from "@/lib/csv";

export function GET() {
  const body = `${INVOICE_CSV_HEADERS.join(",")}\r\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="invoice-chaser-template.csv"',
      "Cache-Control": "no-store",
    },
  });
}
