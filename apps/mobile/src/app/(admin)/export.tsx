import type { JSX } from "react";
import { useState } from "react";
import { Linking, Share, Text, View } from "react-native";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  expiryLabel,
  monthLabel,
  nairobiMonth,
  shareMessage,
  shiftMonth,
} from "~/features/export/export-month";
import { useGenerateExport } from "~/features/export/use-generate-export";
import { describeApiError } from "~/lib/api";

export default function ExportRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => (
        <ExportScreen key={company.organizationId} company={company} />
      )}
    </RequireAdmin>
  );
}

/**
 * The accountant export (spec §6.11): any month's money out, the bills
 * still owed at its end, and its receipts. The accountants also get last
 * month's by email on the 1st.
 */
function ExportScreen({ company }: { company: Company }): JSX.Element {
  const thisMonth = nairobiMonth(new Date());
  const [month, setMonth] = useState(() => shiftMonth(thisMonth, -1));
  const [shareError, setShareError] = useState<string | null>(null);
  const generate = useGenerateExport(company.organizationId);
  const exported = generate.data?.month === month ? generate.data : null;

  function choose(by: number): void {
    setMonth((current) => shiftMonth(current, by));
    setShareError(null);
    generate.reset();
  }

  async function share(): Promise<void> {
    if (!exported) return;
    setShareError(null);
    try {
      await Share.share({ message: shareMessage(company.name, exported) });
    } catch {
      setShareError("Couldn't open sharing. Please try again.");
    }
  }

  function open(url: string): void {
    Linking.openURL(url).catch(() => {
      setShareError("Couldn't open the download. Share the links instead.");
    });
  }

  return (
    <Screen belowHeader>
      <Text className="text-base text-gray-600">
        Everything paid out in a month, salaries included, the bills still owed
        at its end, and the month&apos;s receipts. Accountants also get last
        month&apos;s by email on the 1st.
      </Text>

      <View className="min-h-14 flex-row items-center justify-between gap-3">
        <Button
          label="Previous"
          variant="secondary"
          accessibilityLabel="Previous month"
          onPress={() => choose(-1)}
        />
        <Text
          accessibilityRole="header"
          className="flex-1 text-center text-lg font-semibold text-gray-900"
        >
          {monthLabel(month)}
        </Text>
        <Button
          label="Next"
          variant="secondary"
          accessibilityLabel="Next month"
          disabled={month >= thisMonth}
          onPress={() => choose(1)}
        />
      </View>

      <ErrorMessage
        message={generate.error ? describeApiError(generate.error) : shareError}
      />

      {exported ? (
        <View className="gap-3">
          <Text className="text-base text-gray-900">
            Ready. Anyone with these links can download the export until{" "}
            {expiryLabel(exported.expiresAt)}.
          </Text>
          <Button label="Share links" onPress={() => void share()} />
          <Button
            label="Open spreadsheet (Excel)"
            variant="secondary"
            onPress={() => open(exported.links.workbook)}
          />
          <Button
            label="Open CSV files"
            variant="secondary"
            onPress={() => open(exported.links.csv)}
          />
          <Button
            label="Open receipts"
            variant="secondary"
            onPress={() => open(exported.links.receipts)}
          />
          <Button
            label="Make a fresh export"
            variant="ghost"
            loading={generate.isPending}
            onPress={() => generate.mutate(month)}
          />
        </View>
      ) : (
        <Button
          label="Generate export"
          loading={generate.isPending}
          onPress={() => generate.mutate(month)}
        />
      )}
    </Screen>
  );
}
