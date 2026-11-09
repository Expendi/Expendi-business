import type { JSX } from "react";
import {
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
} from "expo-router";
import { useCallback, useLayoutEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type { ExpendiCard } from "@expendi-business/shared";

import type { PasskeySetupCopy } from "~/features/approval";
import type { RevealSession } from "~/features/cards/card-api";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import {
  ApprovalPasskeyGate,
  describeApprovalError,
} from "~/features/approval";
import {
  canShowDetails,
  maskedCardNumber,
} from "~/features/cards/card-display";
import { RevealedCardDetails } from "~/features/cards/revealed-card-details";
import { useCardReveal, useMyCard } from "~/features/cards/use-cards";
import { RequireCompany } from "~/features/claims/require-company";
import { describeApiError } from "~/lib/api";

const CARDHOLDER_PASSKEY_COPY: PasskeySetupCopy = {
  title: "Set up your passkey",
  description:
    "You confirm it's you with your fingerprint or face each time you look at your card details. Set it up once on this phone.",
};

export default function RevealCardRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <RevealCardScreen company={company} />}
    </RequireCompany>
  );
}

function RevealCardScreen({ company }: { company: Company }): JSX.Element {
  const { cardId } = useLocalSearchParams<{ cardId: string }>();
  const card = useMyCard(company.organizationId, cardId);

  if (card.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the card" />
      </Screen>
    );
  }
  if (card.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(card.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={card.isFetching}
          onPress={() => void card.refetch()}
        />
      </Screen>
    );
  }
  if (!card.data || !canShowDetails(card.data)) {
    return (
      <Screen belowHeader>
        <ErrorMessage message="This card's details can't be shown." />
      </Screen>
    );
  }

  return (
    <RevealFlow organizationId={company.organizationId} card={card.data} />
  );
}

type RevealState =
  | { readonly status: "idle" | "hidden" }
  | { readonly status: "open"; readonly session: RevealSession };

function RevealFlow({
  organizationId,
  card,
}: {
  organizationId: string;
  card: ExpendiCard;
}): JSX.Element {
  const navigation = useNavigation();
  const [state, setState] = useState<RevealState>({ status: "idle" });
  const open = state.status === "open";

  const hide = useCallback(() => {
    setState((current) =>
      current.status === "open" ? { status: "hidden" } : current,
    );
  }, []);

  useFocusEffect(useCallback(() => hide, [hide]));

  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !open });
    return () => navigation.setOptions({ headerShown: true });
  }, [navigation, open]);

  const reveal = useCardReveal(organizationId, card.id, (session) => {
    // The person may have moved on while the passkey was being checked.
    if (navigation.isFocused()) setState({ status: "open", session });
  });

  if (state.status === "open") {
    return <RevealedCardDetails session={state.session} onClose={hide} />;
  }

  return (
    <Screen belowHeader>
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {card.nickname}
        </Text>
        <Text className="text-base text-gray-600">
          {maskedCardNumber(card.lastFour)}
        </Text>
      </View>

      <ApprovalPasskeyGate setupCopy={CARDHOLDER_PASSKEY_COPY}>
        <View className="gap-4">
          <Text className="text-base leading-6 text-gray-600">
            {state.status === "hidden"
              ? "Your card details are hidden again. Confirm with your passkey to see them once more."
              : "Confirm with your passkey to see the card number, expiry and security code. They hide after a few minutes."}
          </Text>
          <ErrorMessage
            message={
              reveal.isError ? describeApprovalError(reveal.error) : null
            }
          />
          <Button
            label="Show card details"
            loading={reveal.isPending}
            onPress={() => reveal.mutate()}
          />
        </View>
      </ApprovalPasskeyGate>
    </Screen>
  );
}
