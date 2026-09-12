# Roles and Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `PRODUCT`, `ADMIN`, and `SUPER_ADMIN` real, distinct meaning (only `SUPER_ADMIN` touches money or creates staff; `ADMIN` keeps operations; `PRODUCT` is visibility-only), and let `SUPER_ADMIN` create staff accounts with a role.

**Architecture:** Add `PRODUCT` to the `UserRole` enum. Re-tier the existing `@Roles(...)` decorators across five backend controllers to match the new matrix (mostly narrowing `ADMIN, SUPER_ADMIN` → `SUPER_ADMIN` on money-tier routes, and widening dispatch-board/operator-view routes to include `PRODUCT`). Add one new admin-only endpoint, `POST /auth/staff`, and remove the dead, unauthenticated `POST /auth/register`. `lrr-web` gets a re-tiered nav, an "Add staff" form on the existing (currently read-only) Manage Users tab, and role-based hiding of mutation controls on the Dispatch Board and Operators tabs (the backend guards are the actual enforcement; the frontend hiding is for a coherent read-only experience).

**Tech Stack:** NestJS, Prisma/Postgres, Next.js/React (`lrr-web`), Jest.

## Global Constraints

- `PRODUCT` is a new `UserRole` enum value (Prisma migration, additive).
- **`SUPER_ADMIN` is the only tier that touches money or creates staff accounts.** Money-tier routes (`Payouts`, `Platform Config` read+write, `Subscription` cancel) narrow from `@Roles(ADMIN, SUPER_ADMIN)` to `@Roles(SUPER_ADMIN)`.
- **`SUPER_ADMIN` is never created or promoted through the API.** `POST /auth/staff`'s `role` field accepts only `ADMIN` or `PRODUCT` — rejecting `SUPER_ADMIN` even though the caller is a `SUPER_ADMIN`, and rejecting `CUSTOMER`/`OPERATOR` (they have their own dedicated self-registration flows). Promoting/creating a `SUPER_ADMIN` remains a manual database operation outside this feature.
- `PRODUCT` gets view access to: Dispatch Board, Operators (listing/stats/profile, not mutations), Requests, Payments, Ratings. `PRODUCT` gets NO access to: Payouts, Platform Settings, Manage Users, any mutation endpoint (dispatch actions, operator verification/suspend/bank-details/availability, staff creation).
- `ADMIN` is unchanged everywhere except money-tier routes and staff creation, both of which it loses.
- Correction to the spec: the spec's Problem section claimed `GET /platform-config` had no `@Roles(...)` at all. That was inaccurate — re-checked directly against `src/platform-config/platform-config.controller.ts` while writing this plan: **both** the `GET` and `PATCH` routes already have `@Roles(ADMIN, SUPER_ADMIN)`. Task 1 below narrows both to `SUPER_ADMIN` — no new guard needs to be *added*, only the existing role list changed. (The spec's `docs/superpowers/specs/2026-08-12-roles-and-permissions-design.md` should be corrected to match — a one-line fix, not deferred to a separate task.)
- No global `ValidationPipe` exists in this app (confirmed repeatedly this session) — the new `POST /auth/staff` endpoint needs a manual `role` validation check in the controller, matching the established pattern (e.g. `RatingController`, `OperatorController.saveBankDetails`).
- `AuthGuard` (`src/auth/auth.guard.ts`, JWT-based, sets `req.user = { userId, phone, role }`) + `RolesGuard` + `@Roles(...)` is this codebase's established guard-stacking pattern — every new/changed route in this plan follows it exactly, matching e.g. `src/payout/payout.controller.ts`'s class-level `@UseGuards(AuthGuard, RolesGuard)` + `@Roles(...)`.

---

### Task 1: Backend — `PRODUCT` role + re-tier existing money/dispatch/operator guards

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/payout/payout.controller.ts`
- Modify: `src/platform-config/platform-config.controller.ts`
- Modify: `src/subscription/subscription.controller.ts`
- Modify: `src/rescue-request/rescue-request.controller.ts`

**Interfaces:**
- Produces: `UserRole.PRODUCT` — consumed by every later task.

- [ ] **Step 1: Add `PRODUCT` to the `UserRole` enum**

In `prisma/schema.prisma`, find:

```prisma
enum UserRole {
  CUSTOMER
  OPERATOR
  ADMIN
  SUPER_ADMIN
}
```

Replace with:

```prisma
enum UserRole {
  CUSTOMER
  OPERATOR
  PRODUCT
  ADMIN
  SUPER_ADMIN
}
```

- [ ] **Step 2: Run the migration**

This is a schema migration requiring explicit human consent per this repo's established pattern. Ask the user to confirm, then run with their consent:

```bash
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes npx prisma migrate dev --name add_product_role
npx prisma generate
```

If `migrate dev` refuses with a non-interactive-environment error (this has happened before in this session for additive-but-warning-producing changes), write the migration file directly instead: create
`prisma/migrations/<UTC-timestamp>_add_product_role/migration.sql` containing
`ALTER TYPE "UserRole" ADD VALUE 'PRODUCT';`, then apply with `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes npx prisma migrate deploy` followed by `npx prisma generate`.

Expected: migration applies cleanly (additive enum value, no drops).

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors (nothing references `PRODUCT` yet, so this just confirms the generated client is valid).

- [ ] **Step 4: Narrow the Payouts guard to `SUPER_ADMIN`**

In `src/payout/payout.controller.ts`, find the class-level decorator:

```typescript
@Controller('payouts')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class PayoutController {
```

Replace with:

```typescript
@Controller('payouts')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class PayoutController {
```

- [ ] **Step 5: Narrow the Platform Config guards to `SUPER_ADMIN`**

In `src/platform-config/platform-config.controller.ts`, both routes currently have `@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)` (one on `@Get()`, one on `@Patch()`). Change both to `@Roles(UserRole.SUPER_ADMIN)`.

- [ ] **Step 6: Narrow the Subscription-cancel guard to `SUPER_ADMIN`**

In `src/subscription/subscription.controller.ts`, find the `DELETE :id` route:

```typescript
  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async cancelSubscription(@Param('id') id: string) {
```

Change `@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)` to `@Roles(UserRole.SUPER_ADMIN)`.

- [ ] **Step 7: Widen the Dispatch Board view route to include `PRODUCT`**

In `src/rescue-request/rescue-request.controller.ts`, find (currently at line 51-53):

```typescript
  @Get('dispatch-board')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async dispatchBoard() {
```

Change to `@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.PRODUCT)`.

Leave every other route in this controller unchanged (`expand-radius`, `offer-to/:operatorId`, `assign-operator`, `:id/status`, `:id/cancel` all stay `@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)` — these are mutations, `PRODUCT` stays excluded per the matrix).

- [ ] **Step 8: Verify TypeScript compiles and the full suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; all suites pass. No existing test asserts on the exact `@Roles(...)` argument list for these routes (decorators aren't unit-tested directly in this codebase — confirmed by grepping this session's own prior test additions, which test service-layer logic, not guard metadata), so no test changes are expected in this task; if any existing test does fail, it means a test was asserting `ADMIN`-without-`SUPER_ADMIN` behavior that these changes altered — read the failure before assuming it's spurious.

- [ ] **Step 9: Fix the spec's inaccurate claim about `GET /platform-config`**

In `docs/superpowers/specs/2026-08-12-roles-and-permissions-design.md`, find the "Also surfaced" and "Backend changes" text claiming `GET /platform-config` had no `@Roles(...)` at all. Correct it to state both routes already had `@Roles(ADMIN, SUPER_ADMIN)` and were narrowed to `SUPER_ADMIN`, not newly guarded. (Exact wording is the implementer's judgment — the point is factual accuracy, not exact phrasing.)

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/payout/payout.controller.ts src/platform-config/platform-config.controller.ts src/subscription/subscription.controller.ts src/rescue-request/rescue-request.controller.ts docs/superpowers/specs/2026-08-12-roles-and-permissions-design.md
git commit -m "feat(roles): add PRODUCT role, restrict money-tier routes to SUPER_ADMIN"
```

---

### Task 2: Backend — `POST /auth/staff` + remove dead `POST /auth/register`

**Files:**
- Create: `src/auth/dto/create-staff.dto.ts`
- Modify: `src/auth/auth.service.ts`
- Modify: `src/auth/auth.controller.ts`
- Test: `src/auth/auth.service.spec.ts` (create if it doesn't exist — check first)

**Interfaces:**
- Consumes: `PRODUCT` role (Task 1), `AuthService.hashPassword` (existing).
- Produces: `AuthService.createStaff(dto: CreateStaffDto): Promise<{ id: string; email: string; name: string | null; role: UserRole }>` — consumed by the controller in this task.

- [ ] **Step 1: Check for an existing `auth.service.spec.ts`**

Run `ls src/auth/*.spec.ts`. If `auth.service.spec.ts` exists, read it first for the established mock/`TestingModule` pattern and follow it exactly in Step 2 below. If it doesn't exist, create it fresh following the pattern used by this session's other from-scratch spec files (e.g. `src/payment/payment.service.spec.ts` — full `TestingModule` with `jest.fn()` mocks for every constructor dependency).

- [ ] **Step 2: Write the failing tests**

Add (or create the file with) this `describe` block, adapting the provider list to whatever `AuthService`'s actual constructor dependencies are (`PrismaService`, `JwtService` — confirm via `src/auth/auth.service.ts`'s constructor before writing the mock shape):

```typescript
  describe('createStaff', () => {
    it('creates a user with the given role and a hashed password', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue({
        id: 'user-1', email: 'staff@example.com', name: 'New Staff', role: 'ADMIN',
      });

      const result = await service.createStaff({
        email: 'staff@example.com', name: 'New Staff', role: 'ADMIN' as any, temporaryPassword: 'temp12345',
      });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'staff@example.com',
          name: 'New Staff',
          role: 'ADMIN',
          passwordHash: expect.any(String),
        }),
      });
      expect(result).toEqual({ id: 'user-1', email: 'staff@example.com', name: 'New Staff', role: 'ADMIN' });
    });

    it('throws ConflictException if the email is already registered', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'existing-1' });

      await expect(
        service.createStaff({ email: 'taken@example.com', name: 'X', role: 'ADMIN' as any, temporaryPassword: 'temp12345' }),
      ).rejects.toThrow('Email already registered');
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx jest auth.service.spec.ts -t "createStaff"
```

Expected: FAIL — method doesn't exist.

- [ ] **Step 4: Create `CreateStaffDto`**

Create `src/auth/dto/create-staff.dto.ts`:

```typescript
import { IsEmail, IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class CreateStaffDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsString()
  @MinLength(8)
  temporaryPassword: string;
}
```

- [ ] **Step 5: Implement `AuthService.createStaff`**

Add to `src/auth/auth.service.ts`, near the existing `register` method (this deliberately does NOT reuse `register` as-is, since `register` doesn't return the shape this endpoint needs and mixing "self-registration" and "admin-creates-staff" in one method invites the two to drift):

```typescript
  /**
   * Admin action: create a staff account (ADMIN or PRODUCT only — never
   * SUPER_ADMIN, never CUSTOMER/OPERATOR, which have their own dedicated
   * self-registration flows). Role restriction is enforced by the
   * controller before this is called; this method trusts its input.
   */
  async createStaff(data: {
    email: string;
    name: string;
    role: UserRole;
    temporaryPassword: string;
  }): Promise<{ id: string; email: string; name: string | null; role: UserRole }> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });
    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await this.hashPassword(data.temporaryPassword);

    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        role: data.role,
        passwordHash,
      },
    });

    return { id: user.id, email: user.email!, name: user.name, role: user.role };
  }
```

- [ ] **Step 6: Remove `POST /auth/register`**

In `src/auth/auth.controller.ts`, delete this entire handler:

```typescript
  /**
   * Register a new user (for testing/admin)
   */
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register({
      email: dto.email,
      password: dto.password,
      name: dto.name,
    });
  }
```

Leave the inline `RegisterDto` class declaration alone even though it becomes unused by this handler — check whether anything else in the file still references `RegisterDto` before deciding whether to delete the class too (grep `RegisterDto` in this file); if nothing else uses it, delete the now-dead class as well, since leaving unused exported types around is exactly the kind of stale-code trap this task is already cleaning up one instance of.

Also remove the now-unused `AuthService.register` method (`src/auth/auth.service.ts`) if grepping confirms nothing else in either repo calls it (check `grep -rn "\.register(" src/` — distinguish from `registerCustomer`/`registerOperator`, which stay).

- [ ] **Step 7: Add `POST /auth/staff`**

In `src/auth/auth.controller.ts`, add the import:

```typescript
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CreateStaffDto } from './dto/create-staff.dto';
```

(Check the file's existing imports first — `UserRole` is not currently imported in this file, confirmed while writing this plan; `AuthGuard` already is.)

Add the endpoint, near the existing `GET /users` route:

```typescript
  /**
   * Create a staff account (SUPER_ADMIN only). role is restricted to
   * ADMIN or PRODUCT — SUPER_ADMIN is never created through this endpoint,
   * even by a SUPER_ADMIN caller (see Global Constraints in the plan this
   * came from: no self-service path to a second SUPER_ADMIN account).
   */
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Post('staff')
  async createStaff(@Body() dto: CreateStaffDto) {
    if (dto.role !== UserRole.ADMIN && dto.role !== UserRole.PRODUCT) {
      throw new BadRequestException('role must be ADMIN or PRODUCT');
    }
    const user = await this.authService.createStaff(dto);
    return { message: 'Staff account created', data: user };
  }
```

`BadRequestException` is already imported in this file (used by the existing `listUsers` handler).

- [ ] **Step 8: Convert `GET /users`'s manual role check to the standard decorator pattern**

Find the existing handler:

```typescript
  @UseGuards(AuthGuard)
  @Get('users')
  async listUsers(
    @Request() req: any,
    @Query('role') role?: string,
    @Query('search') search?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '25',
  ) {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'ADMIN') {
      throw new BadRequestException('Forbidden');
    }
    return this.authService.listUsers({ role, search, page: +page, limit: +limit });
  }
```

Replace with:

```typescript
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('users')
  async listUsers(
    @Query('role') role?: string,
    @Query('search') search?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '25',
  ) {
    return this.authService.listUsers({ role, search, page: +page, limit: +limit });
  }
```

(`@Request() req: any` is dropped since it's no longer needed once the role check moves to the decorator — confirm nothing else in the handler body used `req` before removing the parameter; the body shown above doesn't.)

- [ ] **Step 9: Run tests to verify they pass**

```bash
npx jest auth.service.spec.ts -t "createStaff"
```

Expected: PASS, both tests green.

- [ ] **Step 10: Verify TypeScript compiles and the full suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; all suites pass.

- [ ] **Step 11: Commit**

```bash
git add src/auth/dto/create-staff.dto.ts src/auth/auth.service.ts src/auth/auth.controller.ts src/auth/auth.service.spec.ts
git commit -m "feat(auth): add POST /auth/staff, remove dead unauthenticated register endpoint"
```

---

### Task 3: `lrr-web` — re-tier nav, add `useAuthApi().createStaff`

**Files:**
- Modify: `app/types.ts`
- Modify: `app/components/portal/nav.ts`
- Modify: `app/hooks/useAuthApi.ts`

**Interfaces:**
- Consumes: `POST /auth/staff` (Task 2).
- Produces: `useAuthApi().createStaff(data): Promise<...>` — consumed by Task 4. Re-tiered `PORTAL_NAV` — consumed by Task 5 (nav already reads from this file; no code change needed in the nav-rendering component itself, only this data file).

- [ ] **Step 1: Add `PRODUCT` to the frontend `UserRole` type**

In `app/types.ts`, find:

```typescript
export type UserRole = "SUPER_ADMIN" | "ADMIN" | "OPERATOR" | "CUSTOMER";
```

Change to:

```typescript
export type UserRole = "SUPER_ADMIN" | "ADMIN" | "PRODUCT" | "OPERATOR" | "CUSTOMER";
```

- [ ] **Step 2: Re-tier `PORTAL_NAV`**

In `app/components/portal/nav.ts`, add two new role-group constants alongside the existing ones:

```typescript
const SUPER_ADMIN_ONLY: UserRole[] = ["SUPER_ADMIN"];
const STAFF_VISIBILITY: UserRole[] = ["ADMIN", "SUPER_ADMIN", "PRODUCT"];
```

Update these specific rows in `PORTAL_NAV` (leave every other row unchanged):

```typescript
  { label: "Requests",     href: "/requests",  icon: "sirens",           section: "Main",       roles: [...STAFF_VISIBILITY, "CUSTOMER", "OPERATOR"] },
  { label: "Operators",    href: "/operators", icon: "car",              section: "Management", roles: STAFF_VISIBILITY },
  { label: "Dispatch Board", href: "/dispatch-board", icon: "sirens",    section: "Management", roles: STAFF_VISIBILITY },
  { label: "Payments",     href: "/payments",  icon: "credit-card",      section: "Financial",  roles: [...STAFF_VISIBILITY, ...OPERATOR] },
  { label: "Payouts",      href: "/payouts",   icon: "credit-card",      section: "Financial",  roles: SUPER_ADMIN_ONLY },
  { label: "Platform Settings", href: "/platform-settings", icon: "settings", section: "Management", roles: SUPER_ADMIN_ONLY },
```

Everything else (`Overview`, `Manage Users`, `Team`, `Settings`) is unchanged — check the file's current exact content before editing, since `Requests`'s existing `roles: ALL` already included `CUSTOMER`/`OPERATOR`; the replacement above must keep that (`ALL` = `[CUSTOMER, OPERATOR, ADMIN, SUPER_ADMIN]` per the existing `const ALL` — the new value adds `PRODUCT` to that same set via `STAFF_VISIBILITY`, spelled out explicitly rather than relying on the old `ALL` constant, to make the `PRODUCT` inclusion visible at the call site).

`Manage Users` stays `roles: ADMINS` — per the matrix, `PRODUCT` has no access to user listing.

- [ ] **Step 3: Add `createStaff` to `useAuthApi`**

In `app/hooks/useAuthApi.ts`, add near the existing `listUsers`:

```typescript
  const createStaff = useCallback(async (data: {
    email: string; name: string; role: string; temporaryPassword: string;
  }): Promise<{ id: string; email: string; name: string | null; role: UserRole }> => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/auth/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return res.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create staff account";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);
```

Add `createStaff` to the hook's returned object (alongside `listUsers`).

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/types.ts app/components/portal/nav.ts app/hooks/useAuthApi.ts
git commit -m "feat(roles): re-tier portal nav for PRODUCT/SUPER_ADMIN, add createStaff hook method"
```

---

### Task 4: `lrr-web` — "Add staff" form on Manage Users

**Files:**
- Modify: `app/components/tabs/ManageUsersTab.tsx`

**Interfaces:**
- Consumes: `useAuthApi().createStaff` (Task 3), `useAuthState().role` (existing).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add state and the create-staff handler**

In `app/components/tabs/ManageUsersTab.tsx`, add to the existing imports:

```typescript
import { useAuthState } from "../../hooks";
```

Add to the existing `useAuthApi()` destructuring:

```typescript
  const { listUsers, createStaff } = useAuthApi();
  const { role: myRole } = useAuthState();
```

Add new state (alongside the existing filter/pagination state):

```typescript
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [staffEmail, setStaffEmail] = useState("");
  const [staffName, setStaffName] = useState("");
  const [staffRole, setStaffRole] = useState<"ADMIN" | "PRODUCT">("ADMIN");
  const [staffPassword, setStaffPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ msg: string; ok: boolean } | null>(null);
```

Add the handler:

```typescript
  async function handleCreateStaff(e: React.FormEvent) {
    e.preventDefault();
    setCreateMsg(null);
    setCreating(true);
    try {
      await createStaff({ email: staffEmail, name: staffName, role: staffRole, temporaryPassword: staffPassword });
      setCreateMsg({ msg: "Staff account created.", ok: true });
      setStaffEmail("");
      setStaffName("");
      setStaffPassword("");
      setShowAddStaff(false);
      load(1, search, roleFilter);
    } catch (err) {
      setCreateMsg({ msg: err instanceof Error ? err.message : "Failed to create staff account", ok: false });
    } finally {
      setCreating(false);
    }
  }
```

- [ ] **Step 2: Add the "Add staff" button and form to the JSX**

Add this block right after the existing filter-bar `div` (before the "Table" comment), gated to `SUPER_ADMIN` only:

```tsx
      {myRole === "SUPER_ADMIN" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "1rem 1.25rem", border: "1px solid #e8edf5" }}>
          {!showAddStaff ? (
            <button
              onClick={() => setShowAddStaff(true)}
              style={{ padding: "0.55rem 1rem", background: blue, color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}
            >
              + Add staff
            </button>
          ) : (
            <form onSubmit={handleCreateStaff} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.78rem", color: "#9ca3af", marginBottom: 4 }}>Email</label>
                <input type="email" required value={staffEmail} onChange={(e) => setStaffEmail(e.target.value)} style={{ padding: "0.5rem 0.75rem", borderRadius: 8, border: "1px solid #dde8f8", fontSize: "0.85rem" }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.78rem", color: "#9ca3af", marginBottom: 4 }}>Name</label>
                <input required value={staffName} onChange={(e) => setStaffName(e.target.value)} style={{ padding: "0.5rem 0.75rem", borderRadius: 8, border: "1px solid #dde8f8", fontSize: "0.85rem" }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.78rem", color: "#9ca3af", marginBottom: 4 }}>Role</label>
                <select value={staffRole} onChange={(e) => setStaffRole(e.target.value as "ADMIN" | "PRODUCT")} style={{ padding: "0.5rem 0.75rem", borderRadius: 8, border: "1px solid #dde8f8", fontSize: "0.85rem", appearance: "auto" }}>
                  <option value="ADMIN">Admin</option>
                  <option value="PRODUCT">Product</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.78rem", color: "#9ca3af", marginBottom: 4 }}>Temporary password</label>
                <input type="text" required minLength={8} value={staffPassword} onChange={(e) => setStaffPassword(e.target.value)} style={{ padding: "0.5rem 0.75rem", borderRadius: 8, border: "1px solid #dde8f8", fontSize: "0.85rem" }} />
              </div>
              <button type="submit" disabled={creating} style={{ padding: "0.55rem 1rem", background: blue, color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, fontSize: "0.85rem", cursor: creating ? "not-allowed" : "pointer" }}>
                {creating ? "Creating…" : "Create"}
              </button>
              <button type="button" onClick={() => setShowAddStaff(false)} style={{ padding: "0.55rem 1rem", background: "#fff", color: "#6c7890", border: "1px solid #dde8f8", borderRadius: 8, fontWeight: 600, fontSize: "0.85rem", cursor: "pointer" }}>
                Cancel
              </button>
            </form>
          )}
          {createMsg && (
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.85rem", fontWeight: 600, color: createMsg.ok ? "#19a56b" : "#dc2626" }}>
              {createMsg.msg}
            </p>
          )}
        </div>
      )}
```

Note the deliberate absence of a `SUPER_ADMIN` `<option>` in the role `<select>` — the dropdown offers only `ADMIN`/`PRODUCT`, matching the backend's rejection of `SUPER_ADMIN` on this endpoint, so the form can't even attempt what the API will reject.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Manual verification**

With the backend running, log in as a `SUPER_ADMIN`, open Manage Users, confirm the "+ Add staff" button appears (and does NOT appear when logged in as plain `ADMIN`), create a staff account with role `PRODUCT`, confirm it appears in the user list afterward.

- [ ] **Step 5: Commit**

```bash
git add app/components/tabs/ManageUsersTab.tsx
git commit -m "feat(admin): add staff-creation form to Manage Users, SUPER_ADMIN only"
```

---

### Task 5: `lrr-web` — hide mutation controls from `PRODUCT` on Dispatch Board and Operators

**Files:**
- Modify: `app/components/tabs/DispatchBoardTab.tsx`
- Modify: `app/components/tabs/OperatorsTab.tsx`

**Interfaces:**
- Consumes: `useAuthState().role` (existing).
- Produces: nothing consumed elsewhere.

Both changes in this task are UI polish, not the security boundary — the
underlying backend routes already correctly reject `PRODUCT` (Task 1 for
dispatch actions; the pre-existing `assertCanManageOperator`/
`assertIsMemberOrAdmin` membership checks for operator mutations, which
already fall through to "deny" for any role that isn't `ADMIN`/`SUPER_ADMIN`
and has no `OperatorMember` row — `PRODUCT` satisfies neither, so these
needed no backend change). This task exists so a `PRODUCT` user doesn't see
buttons that will just 403.

- [ ] **Step 1: Hide Dispatch Board's action buttons from `PRODUCT`**

In `app/components/tabs/DispatchBoardTab.tsx`, add to the existing imports:

```typescript
import { useAuthState } from "../../hooks";
```

Add inside the component, alongside the existing hook calls:

```typescript
  const { role } = useAuthState();
```

Find the existing action-buttons block:

```tsx
            {isLive && (
              <div style={{ display: "flex", gap: 8 }}>
```

Change the condition to also require a non-`PRODUCT` role:

```tsx
            {isLive && role !== "PRODUCT" && (
              <div style={{ display: "flex", gap: 8 }}>
```

- [ ] **Step 2: Hide Operators' mutation controls from `PRODUCT`**

In `app/components/tabs/OperatorsTab.tsx`, add to the existing imports:

```typescript
import { useAuthState } from "../../hooks";
```

Add inside the `OperatorsTab` component (not `StatsModal`), alongside the existing `useOperatorApi()` destructuring:

```typescript
  const { role: myRole } = useAuthState();
```

**2a. Availability toggle.** Find (currently around line 407-421):

```tsx
                      <td style={{ padding: "0.9rem 1rem", textAlign: "center" }}>
                        <button
                          onClick={() => handleAvailability(op)}
                          disabled={actionLoading === op.id + "avail" || op.status !== "ACTIVE"}
                          style={{
                            padding: "0.3rem 0.7rem",
                            background: op.isAvailable ? "#d4edda" : "#e2e3e5",
                            color: op.isAvailable ? "#155724" : "#383d41",
                            border: "none", borderRadius: 4, cursor: op.status === "ACTIVE" ? "pointer" : "default",
                            fontSize: "0.82rem", fontWeight: 600,
                            opacity: op.status !== "ACTIVE" ? 0.5 : 1,
                          }}
                        >
                          {op.isAvailable ? "Online" : "Offline"}
                        </button>
                      </td>
```

Replace with (a plain badge instead of a button when `PRODUCT`, same text/colors, no click handler):

```tsx
                      <td style={{ padding: "0.9rem 1rem", textAlign: "center" }}>
                        {myRole === "PRODUCT" ? (
                          <span style={{
                            padding: "0.3rem 0.7rem", borderRadius: 4, fontSize: "0.82rem", fontWeight: 600,
                            background: op.isAvailable ? "#d4edda" : "#e2e3e5",
                            color: op.isAvailable ? "#155724" : "#383d41",
                          }}>
                            {op.isAvailable ? "Online" : "Offline"}
                          </span>
                        ) : (
                          <button
                            onClick={() => handleAvailability(op)}
                            disabled={actionLoading === op.id + "avail" || op.status !== "ACTIVE"}
                            style={{
                              padding: "0.3rem 0.7rem",
                              background: op.isAvailable ? "#d4edda" : "#e2e3e5",
                              color: op.isAvailable ? "#155724" : "#383d41",
                              border: "none", borderRadius: 4, cursor: op.status === "ACTIVE" ? "pointer" : "default",
                              fontSize: "0.82rem", fontWeight: 600,
                              opacity: op.status !== "ACTIVE" ? 0.5 : 1,
                            }}
                          >
                            {op.isAvailable ? "Online" : "Offline"}
                          </button>
                        )}
                      </td>
```

**2b. Status-change buttons.** Find the actions cell's `<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>` block (currently around line 434-479) containing the "Stats" button plus the conditional "Approve"/"Suspend"/"Reinstate" buttons. Wrap only the three status-change buttons (NOT the "Stats" button, which stays visible to everyone) in a single `{myRole !== "PRODUCT" && (...)}` — i.e. change:

```tsx
                          {op.status === "PENDING" && (
                            <button
                              onClick={() => handleStatusChange(op, "ACTIVE")}
```

to:

```tsx
                          {myRole !== "PRODUCT" && op.status === "PENDING" && (
                            <button
                              onClick={() => handleStatusChange(op, "ACTIVE")}
```

and apply the same `myRole !== "PRODUCT" &&` prefix to the `op.status === "ACTIVE"` (Suspend) and `(op.status === "INACTIVE" || op.status === "SUSPENDED")` (Reinstate) conditions — three separate one-line edits, each adding `myRole !== "PRODUCT" &&` right after the opening `{`.

**2c. `StatsModal`'s bank-details edit block.** `StatsModal` is a separate function component in this file (`function StatsModal({ operator, stats, onClose, banks, onSaveBankDetails }: StatsModalProps)`), so it needs the role passed in as a prop rather than calling `useAuthState()` itself (keeps the hook call in one place). Update `StatsModalProps`:

```typescript
interface StatsModalProps {
  operator: Operator;
  stats: OperatorStats | null;
  onClose: () => void;
  banks: Array<{ name: string; code: string }>;
  onSaveBankDetails: (bankCode: string, bankName: string, accountNumber: string) => Promise<void>;
  viewerRole: string | null;
}
```

Update the function signature: `function StatsModal({ operator, stats, onClose, banks, onSaveBankDetails, viewerRole }: StatsModalProps) {`.

Find the bank-details section (currently lines 145-152 plus the form that follows):

```tsx
        <h3 style={{ margin: "1.5rem 0 1rem 0", fontSize: "1rem", color: "#333", borderTop: "1px solid #dde8f8", paddingTop: "1rem" }}>
          Payout bank details
        </h3>
        {operator.bankName && operator.accountNumberLast4 && (
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "#666" }}>
            Current: {operator.bankName} ····{operator.accountNumberLast4} ({operator.accountName})
          </p>
        )}
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
```

Wrap the `<div style={{ display: "flex", gap: "0.75rem", ...` form block (bank select + account number input + Save button — everything up through that `</div>`'s matching close, before the `{msg && (...)}` block that follows it) in `{viewerRole !== "PRODUCT" && ( ... )}`, so `PRODUCT` sees only the heading and the "Current: ..." read-only line, never the edit form.

Where `<StatsModal ... />` is rendered (find `<StatsModal` near the bottom of the file), add the new prop:

```tsx
        <StatsModal
          operator={selectedOp}
          stats={statsMap[selectedOp.id] ?? null}
          onClose={() => setSelectedOp(null)}
          banks={banks}
          viewerRole={myRole}
          onSaveBankDetails={async (bankCode, bankName, accountNumber) => {
```

(keep the existing `onSaveBankDetails={...}` body unchanged — only the new `viewerRole={myRole}` line is added).

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Manual verification**

Log in as `PRODUCT`, open Dispatch Board — confirm rows are visible but no action buttons render. Open Operators — confirm the list/stats are visible, availability shows read-only, no status-change buttons appear, and the `StatsModal`'s bank-details section shows only the "Current: ..." line with no edit form.

- [ ] **Step 5: Commit**

```bash
git add app/components/tabs/DispatchBoardTab.tsx app/components/tabs/OperatorsTab.tsx
git commit -m "feat(roles): hide dispatch/operator mutation controls from PRODUCT role"
```

---

## Post-implementation

After all 5 tasks: use `superpowers:finishing-a-development-branch` — push both repos to `origin/staging`, verify `lrr-service`'s GitHub Actions ECS deploy goes green (`lrr-web` deploys via Vercel with no equivalent CI to watch, same as this session's other features).

**Manual, pre/post-deploy step — call this out explicitly, don't silently skip it:** per the spec's Rollout section, review every existing `ADMIN`-role user in the database after this ships and promote whoever should retain Payouts/Platform-Settings/staff-creation access to `SUPER_ADMIN` via a direct database update. This plan does not automate that — it doesn't know which current `ADMIN` accounts are meant to be "real" super admins.
