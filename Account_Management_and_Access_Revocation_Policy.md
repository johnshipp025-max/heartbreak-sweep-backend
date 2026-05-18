# Account Management and Access Revocation Policy

## Purpose
This document outlines the procedures for maintaining user accounts and revoking access when it is no longer required, no longer being used, or when a person leaves the organization.

## Account Maintenance Procedures
1. **Account Creation**
   - All user accounts are created by authorized administrators upon request and approval.
   - Each account is assigned only the minimum privileges necessary for the user’s role.

2. **Account Review**
   - Accounts are reviewed quarterly to ensure they are still required and appropriately privileged.
   - Inactive accounts (no login for 60 days) are flagged for review and potential deactivation.

## Access Revocation Procedures
1. **Voluntary or Involuntary Termination**
   - Upon notification of a user’s departure, the administrator will immediately disable the user’s account.
   - All access tokens, passwords, and sessions are revoked within 24 hours.
   - The user’s access to all systems, including email, databases, and cloud services, is removed.

2. **Change of Role or Responsibilities**
   - When a user’s role changes, access is reviewed and adjusted to reflect new responsibilities.
   - Any access no longer required is revoked immediately.

3. **Periodic Access Review**
   - Quarterly audits are performed to identify and remove unused or unnecessary accounts.
   - Accounts with no activity for 60 days are disabled and scheduled for deletion after 30 additional days if not reactivated.

## Evidence of Implementation

### Example: Access Revocation Log

| Date       | User         | Action           | Performed By | Notes                       |
|------------|--------------|------------------|--------------|-----------------------------|
| 2026-04-27 | jdoe         | Account Disabled | admin1       | User left organization      |
| 2026-04-27 | asmith       | Access Revoked   | admin2       | Role changed, DB access off |
| 2026-03-15 | bjones       | Account Deleted  | admin1       | Inactive >90 days           |

---

This log is maintained for all access changes and is reviewed during quarterly audits.

## Enforcement
Failure to follow these procedures may result in disciplinary action and/or security review.

---
**Document Owner:** Security Administrator
**Last Updated:** 2026-04-27
