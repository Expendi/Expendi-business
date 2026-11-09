import type { Href } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import { useRouter } from "expo-router";
import {
  Banknote,
  CircleCheck,
  Contact,
  CreditCard,
  Download,
  FileText,
  Plus,
  Receipt,
  Repeat,
  Users,
  Wallet,
} from "lucide-react-native";
import { Pressable, View } from "react-native";

import { ListRow } from "~/components/list-row";
import { Section } from "~/components/section";
import { Text } from "~/components/text";
import { colors } from "~/theme/colors";

interface WorkspaceLink {
  title: string;
  subtitle: string;
  href: Href;
  icon: LucideIcon;
}

const COMPANY_GROUPS: readonly {
  title: string;
  items: readonly WorkspaceLink[];
}[] = [
  {
    title: "Spend & pay",
    items: [
      {
        title: "Approvals",
        subtitle: "Review claims and approve payments",
        href: "/approvals",
        icon: CircleCheck,
      },
      {
        title: "Bills",
        subtitle: "Due, overdue and paid",
        href: "/bills",
        icon: FileText,
      },
      {
        title: "Recurring payments",
        subtitle: "Manage ongoing company commitments",
        href: "/recurring",
        icon: Repeat,
      },
      {
        title: "Payroll",
        subtitle: "Salaries and payroll runs",
        href: "/payroll",
        icon: Banknote,
      },
      {
        title: "Company spending",
        subtitle: "Purchases paid by bank, card or cash",
        href: "/spending",
        icon: Receipt,
      },
    ],
  },
  {
    title: "Money & reports",
    items: [
      {
        title: "Wallet",
        subtitle: "USDC balance, deposits and withdrawals",
        href: "/wallet",
        icon: Wallet,
      },
      {
        title: "Petty cash floats",
        subtitle: "Issue, top up and reconcile floats",
        href: "/petty-cash/floats",
        icon: Banknote,
      },
      {
        title: "Monthly export",
        subtitle: "Share reports and receipts",
        href: "/export",
        icon: Download,
      },
    ],
  },
  {
    title: "People",
    items: [
      {
        title: "Payees",
        subtitle: "Suppliers and payment details",
        href: "/payees",
        icon: Contact,
      },
      {
        title: "Team",
        subtitle: "Invitations and company roles",
        href: "/team",
        icon: Users,
      },
    ],
  },
];

export function WorkspaceNavigation({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  return (
    <View className="gap-7">
      {isAdmin
        ? COMPANY_GROUPS.map((group) => (
            <Section key={group.title} title={group.title}>
              <View className="gap-2">
                {group.items.map((item) => (
                  <ListRow
                    key={item.title}
                    title={item.title}
                    subtitle={item.subtitle}
                    icon={item.icon}
                    onPress={() => router.push(item.href)}
                  />
                ))}
              </View>
            </Section>
          ))
        : null}
      <Section title="Your work">
        <View className="gap-2">
          <ListRow
            title="Claims"
            subtitle={
              isAdmin
                ? "Everyone’s claims, and your own"
                : "Receipts and reimbursements"
            }
            icon={Receipt}
            onPress={() => router.push("/claims")}
          />
          <ListRow
            title="My Expendi cards"
            subtitle="Your cards, purchases and receipts"
            icon={CreditCard}
            onPress={() => router.push("/cards")}
          />
          <ListRow
            title="My petty cash"
            subtitle="Your float balance and spending"
            icon={Wallet}
            onPress={() => router.push("/petty-cash")}
          />
          <ListRow
            title="My salary payments"
            subtitle="Your pay from this company"
            icon={Banknote}
            onPress={() => router.push("/salary-payments")}
          />
        </View>
      </Section>
    </View>
  );
}

export function QuickActions({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const actions: { title: string; icon: LucideIcon; href: Href }[] = isAdmin
    ? [
        { title: "Approvals", icon: CircleCheck, href: "/approvals" },
        { title: "Bills", icon: FileText, href: "/bills" },
        { title: "Wallet", icon: Wallet, href: "/wallet" },
      ]
    : [
        { title: "New claim", icon: Plus, href: "/claims/new" },
        { title: "Petty cash", icon: Wallet, href: "/petty-cash" },
        { title: "My pay", icon: Banknote, href: "/salary-payments" },
      ];
  return (
    <View className="flex-row gap-3">
      {actions.map(({ title, icon: Icon, href }) => (
        <Pressable
          key={title}
          accessibilityRole="button"
          accessibilityLabel={title}
          onPress={() => router.push(href)}
          className="min-w-0 flex-1 items-center gap-2 rounded-xl border border-gray-200 bg-white px-2 py-4 active:bg-brand-50"
        >
          <Icon
            size={22}
            strokeWidth={1.75}
            color={colors.brandStrong}
            accessible={false}
          />
          <Text className="text-center text-sm font-medium leading-5 text-gray-900">
            {title}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
