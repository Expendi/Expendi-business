import { CompanyView } from "./_components/company-view";

export default async function CompanyPage({
  params,
}: PageProps<"/companies/[id]">) {
  const { id } = await params;
  return <CompanyView companyId={id} />;
}
