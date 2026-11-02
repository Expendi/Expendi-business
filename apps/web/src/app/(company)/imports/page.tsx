import { ImportsView } from "./view";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind } = await searchParams;
  return <ImportsView initialKind={kind === "bill" ? "bill" : "history"} />;
}
