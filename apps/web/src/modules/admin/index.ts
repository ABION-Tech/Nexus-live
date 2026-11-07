// modules/admin/ — Group Admin + Company Admin dashboards
// (ADMIN_BUILD_GUIDE.md §3 "Session 6"), plus Super Admin
// (ADMIN_BUILD_GUIDE.md §3 "Session 5" — repo Session 43). Scaffolded
// empty in Session 37, Group/Company filled in Session 42, Super Admin
// filled in this session. See app/ia.ts for the `adminGate`-driven
// section-visibility rule and app/App.tsx's renderSubsection for the
// routing.
export * from './GroupOverview';
export * from './GroupCompanies';
export * from './GroupPeople';
export * from './GroupOperations';
export * from './GroupGoals';
export * from './GroupAnalytics';
export * from './GroupActivity';
export * from './CompanyOverview';
export * from './CompanyAnalytics';
export * from './CompanyAutomation';
export * from './CompanyActivity';
export * from './CompanySettings';
export * from './SuperOverview';
export * from './SuperOrganizations';
export * from './SuperUsers';
export * from './SuperAudit';
export * from './SuperBilling';
