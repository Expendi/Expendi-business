import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import {
  createOrganizationRequestSchema,
  ORGANIZATION_NAME_MAX_LENGTH,
} from "@expendi-business/shared";

import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import { useAuth } from "~/features/auth/auth-provider";
import { useCompanySession } from "~/features/company/company-provider";
import { useCreateCompany } from "~/features/company/use-create-company";
import { useMe } from "~/features/me/use-me";
import { describeApiError } from "~/lib/api";

interface FieldErrors {
  name?: string;
  kraPin?: string;
}

export default function CreateCompanyScreen(): JSX.Element {
  const router = useRouter();
  const { signOut } = useAuth();
  const { state, selectCompany } = useCompanySession();
  const meQuery = useMe();
  const createCompany = useCreateCompany();
  const [name, setName] = useState("");
  const [kraPin, setKraPin] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [createdId, setCreatedId] = useState<string | null>(null);

  const createdIsSelected =
    createdId !== null &&
    state.status === "ready" &&
    state.company.organizationId === createdId;
  const createdButNotLoaded =
    createdId !== null && !createdIsSelected && !meQuery.isFetching;

  useEffect(() => {
    if (createdIsSelected) {
      router.replace({ pathname: "/wallet", params: { welcome: "1" } });
    }
  }, [createdIsSelected, router]);

  function handleSubmit(): void {
    const parsed = createOrganizationRequestSchema.safeParse({ name, kraPin });
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if ((field === "name" || field === "kraPin") && !errors[field]) {
          errors[field] = issue.message;
        }
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    createCompany.mutate(parsed.data, {
      onSuccess: (company) => {
        selectCompany(company.id);
        setCreatedId(company.id);
      },
    });
  }

  if (createdButNotLoaded) {
    return (
      <Screen belowHeader>
        <View className="gap-2">
          <Text className="text-2xl font-bold text-gray-900">
            Your company is created
          </Text>
          <Text className="text-base text-gray-600">
            We couldn’t load it yet. Check your connection and try again.
          </Text>
        </View>
        <Button label="Try again" onPress={() => void meQuery.refetch()} />
      </Screen>
    );
  }

  const submitting = createCompany.isPending || createdId !== null;

  return (
    <Screen belowHeader>
      <Text className="text-base text-gray-600">
        You’ll be the company’s first admin. Next, you’ll get the address to
        deposit USDC to.
      </Text>

      <View className="gap-4">
        <TextField
          label="Company name"
          value={name}
          onChangeText={setName}
          placeholder="Acme Traders Ltd"
          autoCapitalize="words"
          maxLength={ORGANIZATION_NAME_MAX_LENGTH}
          editable={!submitting}
        />
        <ErrorMessage message={fieldErrors.name ?? null} />

        <TextField
          label="KRA PIN"
          value={kraPin}
          onChangeText={(value) => setKraPin(value.toUpperCase())}
          placeholder="P051234567X"
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!submitting}
        />
        <Text className="text-sm text-gray-500">
          A or P, then 9 digits and a letter, e.g. P051234567X.
        </Text>
        <ErrorMessage message={fieldErrors.kraPin ?? null} />

        <ErrorMessage
          message={
            createCompany.isError ? describeApiError(createCompany.error) : null
          }
        />
        <Button
          label="Create company"
          loading={submitting}
          onPress={handleSubmit}
        />
      </View>

      {state.status === "no-company" ? (
        <View className="gap-3">
          <Text className="text-sm text-gray-600">
            Joining your company instead? Ask an admin to invite{" "}
            {state.me.user.email}, then sign in again.
          </Text>
          <Button
            label="Sign out"
            variant="ghost"
            disabled={submitting}
            onPress={() => void signOut()}
          />
        </View>
      ) : null}
    </Screen>
  );
}
