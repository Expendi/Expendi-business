import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type { CardPurchase, Category } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { attachReceiptRequest } from "~/features/cards/card-api";
import { purchaseAmount } from "~/features/cards/card-display";
import {
  useAttachCardReceipt,
  useCardPurchase,
} from "~/features/cards/use-cards";
import { CategoryField, ReviewRow } from "~/features/claims/claim-editor";
import { ReceiptPicker } from "~/features/claims/receipt-picker";
import { RequireCompany } from "~/features/claims/require-company";
import { useCategories } from "~/features/claims/use-claims";
import { useReceiptSlots } from "~/features/claims/use-receipt-slots";
import { describeApiError } from "~/lib/api";

export default function AddCardReceiptRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <AddCardReceiptScreen company={company} />}
    </RequireCompany>
  );
}

function AddCardReceiptScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { purchaseId } = useLocalSearchParams<{
    purchaseId: string;
  }>();
  const purchase = useCardPurchase(company.organizationId, purchaseId);

  if (purchase.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the purchase" />
      </Screen>
    );
  }
  if (purchase.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(purchase.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={purchase.isFetching}
          onPress={() => void purchase.refetch()}
        />
      </Screen>
    );
  }
  if (!purchase.data?.needsReceipt) {
    return (
      <Screen belowHeader>
        <Text className="text-base text-gray-600">
          {purchase.data
            ? "This purchase doesn’t need a receipt."
            : "We couldn’t find this purchase on your cards."}
        </Text>
        <Button
          label="Back"
          variant="secondary"
          onPress={() => router.back()}
        />
      </Screen>
    );
  }

  return (
    <AddReceiptForm
      organizationId={company.organizationId}
      purchase={purchase.data}
    />
  );
}

/** The category can only change with the first receipt (spec §6.25). */
function AddReceiptForm({
  organizationId,
  purchase,
}: {
  organizationId: string;
  purchase: CardPurchase;
}): JSX.Element {
  const router = useRouter();
  const receipts = useReceiptSlots(organizationId);
  const categoryList = useCategories(organizationId);
  const attach = useAttachCardReceipt(organizationId, purchase.id);
  const [categoryId, setCategoryId] = useState(purchase.category.id);
  const [changingCategory, setChangingCategory] = useState(false);
  const categories: Category[] | undefined =
    categoryList.data &&
    !categoryList.data.some(({ id }) => id === purchase.category.id)
      ? [
          ...categoryList.data,
          { ...purchase.category, etimsNotRequired: false },
        ]
      : categoryList.data;
  const amount = purchaseAmount(purchase);

  function save(): void {
    attach.mutate(
      attachReceiptRequest(
        receipts.receiptFileIds,
        categoryId,
        purchase.category.id,
      ),
      { onSuccess: () => router.back() },
    );
  }

  return (
    <Screen belowHeader>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {purchase.merchant}
        </Text>
        {amount ? (
          <Text className="text-base text-gray-600">{amount}</Text>
        ) : null}
      </View>

      <ReceiptPicker receipts={receipts} disabled={attach.isPending} />

      {changingCategory ? (
        <CategoryField
          categories={categories}
          loading={categoryList.isPending}
          loadError={categoryList.error}
          onRetry={() => void categoryList.refetch()}
          value={categoryId}
          onChange={setCategoryId}
        />
      ) : (
        <View className="gap-3">
          <ReviewRow label="Category" value={purchase.category.name} />
          <Button
            label="Change category"
            variant="ghost"
            disabled={attach.isPending}
            onPress={() => setChangingCategory(true)}
          />
        </View>
      )}

      <View className="gap-3">
        <ErrorMessage
          message={attach.isError ? describeApiError(attach.error) : null}
        />
        <Button
          label="Add receipt"
          loading={attach.isPending}
          disabled={receipts.receiptFileIds.length === 0 || receipts.uploading}
          onPress={save}
        />
      </View>
    </Screen>
  );
}
