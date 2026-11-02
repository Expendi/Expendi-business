import { ZohoBooksView } from "./_components/zoho-books-view";

export default async function CompanyZohoBooksPage({
  params,
}: PageProps<"/companies/[id]/zoho">) {
  const { id } = await params;
  return <ZohoBooksView companyId={id} />;
}
