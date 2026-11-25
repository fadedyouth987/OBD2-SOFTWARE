import type { Me, Permission } from "@/lib/api";

/** Mirrors services/cloud-api/app/services/permissions.py, for older API responses. */
const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  OWNER: [
    "MANAGE_BILLING",
    "TRANSFER_OWNERSHIP",
    "MANAGE_ROLES",
    "REMOVE_MEMBERS",
    "MANAGE_SITES",
    "INVITE_MEMBERS",
    "INVITE_LEAD_TECHS",
    "MANAGE_ALL_JOBS",
    "MANAGE_SHARED_FILES",
    "SUBMIT_WORKSHOP_ACCREDITATION",
    "VIEW_TEAM_AUDIT",
  ],
  LEAD_TECH: ["INVITE_MEMBERS", "MANAGE_ALL_JOBS", "MANAGE_SHARED_FILES", "VIEW_TEAM_AUDIT"],
  TECH: [],
};

/** Whether the signed-in user's role allows `permission` in this workshop. The API enforces it too. */
export function can(me: Me | null | undefined, permission: Permission): boolean {
  if (!me) return false;
  const list = me.workspace.permissions ?? ROLE_PERMISSIONS[me.workspace.role] ?? [];
  return list.includes(permission);
}

/** Whether the user may delete a shared file they or someone else uploaded. */
export function canDeleteFile(me: Me | null | undefined, uploadedBy: string | null | undefined): boolean {
  if (!me) return false;
  return (uploadedBy != null && uploadedBy === me.user.id) || can(me, "MANAGE_SHARED_FILES");
}
