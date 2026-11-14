import type { TabItem } from "~/components/tab-bar";
import {
  Banknote,
  Building2,
  FileText,
  House,
  ReceiptText,
  User,
  Users,
  Wallet,
} from "lucide-react-native";

/** Admins run the company: Home · Bills · Expenses · Payroll · Company. */
export const ADMIN_TABS: readonly TabItem[] = [
  { name: "index", label: "Home", icon: House },
  { name: "bills", label: "Bills", icon: FileText },
  { name: "expenses", label: "Expenses", icon: ReceiptText },
  { name: "payroll", label: "Payroll", icon: Users },
  { name: "company", label: "Company", icon: Building2 },
];

/** Employees and accountants see their own work: Home · Petty cash · Pay · Profile. */
export const MEMBER_TABS: readonly TabItem[] = [
  { name: "index", label: "Home", icon: House },
  { name: "me/petty-cash", label: "Petty cash", icon: Wallet },
  { name: "me/pay", label: "Pay", icon: Banknote },
  { name: "me/profile", label: "Profile", icon: User },
];
