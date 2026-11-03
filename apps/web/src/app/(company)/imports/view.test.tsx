import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { ImportNewRecords } from "~/features/imports/import-new-records";
import { ImportResults } from "~/features/imports/import-results";
import { ImportsView } from "./view";

vi.mock("~/lib/use-api", () => ({ useApi: () => ({ get: vi.fn() }) }));

function render(role: "admin" | "accountant", initialKind: "history" | "bill") {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["imports", "company-1", "history"], {
    pages: [{ imports: [], nextOffset: null }],
    pageParams: [0],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: "company-1", name: "Acme", role }}
      >
        <ImportsView initialKind={initialKind} />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}
describe("self-service importer", () => {
  it("lets admins choose a file and template with the correct company and destination", () => {
    const html = render("admin", "bill");
    expect(html).toContain('type="file"');
    expect(html).toContain('value="bill" selected=""');
    expect(html).toContain("unpaid-bills-template.csv");
    expect(html).toContain("Acme");
    expect(html).toContain("Imports never send money");
    expect(html).toContain("Import history");
    expect(html).toContain(
      "Create missing suppliers and categories when I confirm",
    );
    expect(html).not.toContain("Preview import");
  });
  it("does not expose upload or history controls to accountants", () => {
    const html = render("accountant", "history");
    expect(html).toContain("Only company admins");
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("Download example");
    expect(html).not.toContain("Import history");
  });
  it("escapes uploaded content and distinguishes completed rows from preview rows", () => {
    const rows = [
      {
        row: 7,
        status: "ready" as const,
        message: "Ready to import.",
        values: { name: "<script>alert(1)</script>" },
      },
    ];
    const html = renderToStaticMarkup(<ImportResults rows={rows} completed />);
    expect(html).toContain("Imported successfully");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("shows proposed master records as creations and retains them in completed results", () => {
    const records = [
      { kind: "supplier" as const, name: "<New Supplier>" },
      { kind: "category" as const, name: "Travel" },
    ];
    const html = renderToStaticMarkup(<ImportNewRecords records={records} />);
    expect(html).toContain("Create new supplier:");
    expect(html).toContain("&lt;New Supplier&gt;");
    expect(html).toContain("Create new category:");
    expect(html).toContain("no payment details");
    const completed = renderToStaticMarkup(
      <ImportResults
        completed
        rows={[
          {
            row: 2,
            status: "ready",
            values: {},
            message: "Ready",
            newRecords: records,
          },
        ]}
      />,
    );
    expect(completed).toContain("Created supplier:");
    expect(completed).not.toContain("Create new");
    expect(renderToStaticMarkup(<ImportNewRecords records={[]} />)).toBe("");
  });
});
