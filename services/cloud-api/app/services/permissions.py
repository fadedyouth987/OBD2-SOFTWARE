"""What each workshop role may do.

- Owner: everything, including billing, the plan, roles, sites and handing
  ownership to someone else.
- Lead tech: runs the floor. Manages every job (edit, close, reassign), invites
  technicians and revokes open invites, and manages the workshop's shared files.
  No billing, plan, role, site or ownership changes.
- Tech: works their own jobs and their own uploads; sees the rest read-only.

The API enforces these; the web app only uses ``permissions`` from /auth/me to
hide controls the user can't use.
"""

from __future__ import annotations

import enum
from typing import TYPE_CHECKING
from uuid import UUID

from fastapi import HTTPException, status

from app.db.models import MembershipRole

if TYPE_CHECKING:
    from app.api.deps import Principal


class Permission(enum.StrEnum):
    MANAGE_BILLING = "manage_billing"
    TRANSFER_OWNERSHIP = "transfer_ownership"
    MANAGE_ROLES = "manage_roles"
    REMOVE_MEMBERS = "remove_members"
    MANAGE_SITES = "manage_sites"
    INVITE_MEMBERS = "invite_members"
    INVITE_LEAD_TECHS = "invite_lead_techs"
    MANAGE_ALL_JOBS = "manage_all_jobs"
    MANAGE_SHARED_FILES = "manage_shared_files"
    SUBMIT_WORKSHOP_ACCREDITATION = "submit_workshop_accreditation"
    VIEW_TEAM_AUDIT = "view_team_audit"


ROLE_PERMISSIONS: dict[MembershipRole, frozenset[Permission]] = {
    MembershipRole.OWNER: frozenset(Permission),
    MembershipRole.LEAD_TECH: frozenset(
        {
            Permission.INVITE_MEMBERS,
            Permission.MANAGE_ALL_JOBS,
            Permission.MANAGE_SHARED_FILES,
            Permission.VIEW_TEAM_AUDIT,
        }
    ),
    MembershipRole.TECH: frozenset(),
}

_DENIED: dict[Permission, str] = {
    Permission.MANAGE_BILLING: "Only the workshop owner can manage billing and the plan",
    Permission.TRANSFER_OWNERSHIP: "Only the workshop owner can hand over ownership",
    Permission.MANAGE_ROLES: "Only the workshop owner can change roles",
    Permission.REMOVE_MEMBERS: "Only the workshop owner can remove members",
    Permission.MANAGE_SITES: "Only the workshop owner can manage sites",
    Permission.INVITE_MEMBERS: "Only the owner or a lead tech can invite people",
    Permission.INVITE_LEAD_TECHS: "Only the workshop owner can invite lead techs",
    Permission.MANAGE_ALL_JOBS: "Only the owner or a lead tech can change other people's jobs",
    Permission.MANAGE_SHARED_FILES: "Only the owner or a lead tech can delete other people's files",
    Permission.SUBMIT_WORKSHOP_ACCREDITATION: (
        "Only the workshop owner can submit the workshop's AASRA details"
    ),
    Permission.VIEW_TEAM_AUDIT: "Only the owner or a lead tech can see the team history",
}


def permissions_for(role: MembershipRole) -> frozenset[Permission]:
    return ROLE_PERMISSIONS.get(role, frozenset())


def can(principal: Principal, permission: Permission) -> bool:
    return permission in permissions_for(principal.role)


def require(principal: Principal, permission: Permission) -> None:
    if not can(principal, permission):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_DENIED[permission])


def require_own_or(principal: Principal, owner_id: UUID | None, permission: Permission) -> None:
    """Allow the record's own user, otherwise require ``permission``."""
    if owner_id is not None and owner_id == principal.user_id:
        return
    require(principal, permission)


def permission_list(role: MembershipRole) -> list[str]:
    return sorted(p.value for p in permissions_for(role))
