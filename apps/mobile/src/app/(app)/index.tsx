import type { JSX } from "react";

import { LoadingScreen } from "~/components/loading-screen";
import { useCompanySession } from "~/features/company/company-provider";
import { AdminHome } from "~/features/overview/admin-home";
import { EmployeeHome } from "~/features/overview/employee-home";

export default function HomeRoute(): JSX.Element {
  const { state } = useCompanySession();
  if (state.status !== "ready") {
    return <LoadingScreen label="Loading your company" />;
  }
  const { me, company, companies } = state;
  if (company.role === "admin") {
    return (
      <AdminHome
        key={company.organizationId}
        me={me}
        company={company}
        canSwitchCompany={companies.length > 1}
      />
    );
  }
  return (
    <EmployeeHome
      key={company.organizationId}
      me={me}
      company={company}
      canSwitchCompany={companies.length > 1}
    />
  );
}
