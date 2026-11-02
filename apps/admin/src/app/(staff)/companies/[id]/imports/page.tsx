import { ImportView } from "./view";

export default async function ImportsPage({
  params,
}: PageProps<"/companies/[id]/imports">) {
  const { id } = await params;
  return <ImportView companyId={id} />;
}
