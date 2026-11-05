import type { JSX } from "react";
import { View } from "react-native";

import { CopyButton } from "~/components/copy-button";
import { Text } from "~/components/text";
import { useOrganization } from "~/features/company/use-organization";

/**
 * The company's KRA PIN, for staff to give at the till so the eTIMS
 * invoice is issued to the company (spec §6.6). Hidden until it loads, and
 * for a company that never gave one.
 */
export function CompanyPinCard({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element | null {
  const organization = useOrganization(organizationId);
  const kraPin = organization.data?.kraPin;
  if (!kraPin) return null;
  return (
    <View className="gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <View className="gap-1">
        <Text className="text-sm font-medium text-gray-700">
          Company KRA PIN
        </Text>
        <Text
          selectable
          className="text-2xl font-bold tracking-widest text-gray-900"
        >
          {kraPin}
        </Text>
        <Text className="text-sm text-gray-600">
          Give this PIN at the till to get an eTIMS invoice for the company.
        </Text>
      </View>
      <CopyButton
        value={kraPin}
        label="Copy PIN"
        failureMessage="Couldn’t copy the PIN. Read it out instead."
      />
    </View>
  );
}
