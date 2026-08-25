# SkillParkho Admin Backend — Verified Contacts

Node.js + Express backend that powers the **React Admin Panel** and exposes APIs for the **Flutter HR Tracker app** to check verified HR phone numbers.

Supabase project: `https://lkmqpllmxrjgnwmqjrgl.supabase.co`

---

## Quick Start

```bash
cd skillparkho-admin-backend
npm install
# edit .env if needed (already prefilled for dev)
npm run dev   # http://localhost:4000
npm start     # production
```

### 1. Run Supabase Migration

Before starting the server, run the SQL migration to create tables:

1. Open Supabase SQL Editor: https://supabase.com/dashboard/project/lkmqpllmxrjgnwmqjrgl/sql/new
2. Copy & paste `supabase/schema.sql`
3. Click **Run**

Verify:
```bash
curl http://localhost:4000/api/health
# should return { connected: true, tableExists: true }
```

### 2. Test Auth

```bash
curl -X POST http://localhost:4000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@skillparkho.com","password":"SkillParkho@123"}'
# -> { success: true, token: "eyJ..." }

# Use token for protected routes
TOKEN=<token_from_above>

curl http://localhost:4000/api/verified-contacts \
  -H "Authorization: Bearer $TOKEN"

curl http://localhost:4000/api/verified-contacts/stats/summary \
  -H "Authorization: Bearer $TOKEN"
```

### 3. Env Vars (.env)

| Key | Description |
|-----|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role secret — bypasses RLS. For dev you can use anon key due to open policy. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Admin panel login |
| `JWT_SECRET` | Secret to sign admin JWTs |
| `CORS_ORIGIN` | Allowed origins |

---

## API Reference

### Public (no auth) — consumed by Flutter app

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/public/verified-contacts?search=&phone=&page=&limit=` | List verified contacts (verified=true only) |
| `GET` | `/api/public/verified-contacts/check/:phone` | Check if single phone is verified → `{ isVerified, data }` |

**Flutter integration example:**

```dart
// services/verified_contacts_service.dart
final res = await http.get(Uri.parse(
  'http://YOUR_BACKEND/api/public/verified-contacts/check/9811122233'
));
// { isVerified: true, data: { hr_name: "Amit Verma", company_name: "TCS" } }
```

### Admin (Bearer JWT required)

Login first: `POST /api/admin/login`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/admin/login` | `{ email, password }` → `{ token }` |
| `GET` | `/api/admin/me` | Current admin |
| `GET` | `/api/verified-contacts` | List with `?search=&page=&limit=&company=&verified=&sortBy=` |
| `GET` | `/api/verified-contacts/:id` | Single |
| `POST` | `/api/verified-contacts` | Create single |
| `PUT` | `/api/verified-contacts/:id` | Update |
| `DELETE` | `/api/verified-contacts/:id` | Delete |
| `POST` | `/api/verified-contacts/bulk` | `{ contacts: [...] }` bulk JSON |
| `POST` | `/api/verified-contacts/import` | Multipart file upload (`file` field) — supports `.csv`, `.xlsx`, `.json` |
| `GET` | `/api/verified-contacts/export/csv` | Export CSV download |
| `GET` | `/api/verified-contacts/stats/summary` | Dashboard stats |

**Single create body:**

```json
{
  "phone_number": "+91 9811122233",
  "hr_name": "Amit Verma",
  "company_name": "TCS",
  "location": "Noida, Sector 62",
  "hr_designation": "Talent Acquisition Executive",
  "job_position_called_for": "Desktop Support Engineer",
  "email": "amit@ttcs.com",
  "verified": true,
  "verification_status": "verified"
}
```

**CSV format** — headers are flexible (case-insensitive aliases supported):

```csv
phone_number,hr_name,company_name,location,hr_designation,job_position_called_for,email
9811122233,Amit Verma,TCS,Noida,Talent Acquisition,Desktop Support Engineer,amit@tcs.com
```

Also accepts: `phone`, `mobile`, `Name`, `Company`, `Designation`, `Position` etc.

---

## Phone Normalization

Matches Flutter's `phone_normalizer.dart`: strips non-digits, handles `+91` / `91` / `0` prefixes, keeps last 10 digits. Stored as `normalized_phone_number` (unique).

---

## Project Structure

```
src/
  config/supabase.js      # Supabase clients
  controllers/
    authController.js
    verifiedContactsController.js
  routes/
    auth.js
    verifiedContacts.js
  middleware/auth.js
  utils/
    phoneNormalizer.js
    validator.js
  server.js
supabase/schema.sql       # Migration to run in Supabase dashboard
```

---

## Deployment

- **Backend:** Deploy to Render / Railway / Fly / Vercel (Node) — set env vars
- **Supabase:** Ensure RLS policies allow `anon` read for `verified_hr_contacts` (already in schema)
- **Flutter app:** Set backend URL in `lib/services/verified_contacts_service.dart` (next step — see Admin Panel README)
