# AICTE FLOW — SIH 2026 Workflow Automation Prototype

A functional, local demonstration prototype based on the supplied SIH 2026 PPT: **Integrated AICTE Approval Workflow Automation, Compliance Monitoring and Alert Management System** (Problem Statement SIH26262).

> **Important:** This is a student/demo prototype using synthetic records. It is not an official AICTE service, is not connected to AICTE systems, and must not be used to make real approval decisions. The workflow rules and sample records are illustrative. Confirm any real rules against the current officially approved Approval Process Handbook before use.

## Included components mapped to the PPT

- **Institution portal:** create an application, upload required files, view stage/status, see missing-document reasons, correct and resubmit.
- **Document checklist:** six configurable demo document types; PDF/PNG/JPG/TXT allow-list; 10 MB per-file limit; missing-file checks; SHA-256 fingerprint stored for traceability; optional Tesseract OCR for images.
- **Workflow routing:** stage list (Submitted → Regional Scrutiny → Bureau Review → EVC / Inspection → Committee Review → Decision); authorized staff can forward to a stage or return for correction with a reason; final Approved/Rejected decision.
- **Role-based access:** Institution, Regional Officer, Bureau Officer, Committee and Administrator roles; JWT sign-in and server-side route authorization.
- **Compliance tracking:** application deadline, compliance due date and lease expiry fields.
- **Deadline/expiry scheduler:** runs on startup and once daily; creates in-app reminders and deduplicates a reminder event using a unique key; escalates to staff roles.
- **EVC:** schedule a visit, assign an officer/team, record notes and mark visit completed.
- **Dashboards/reports:** application overview, stage distribution, status counts and stage-wise report.
- **Alerts:** workflow notifications, deadline/expiry alerts and read/unread state. Optional SMTP email delivery is implemented and remains disabled by default.
- **Audit trail:** logs sign-in, application creation/submission, file upload, workflow changes, EVC events and rule version changes.
- **Versioned workflow rules:** administrators can create new JSON rule versions; the audit log records version creation.
- **Database and file storage:** PostgreSQL database and a Docker-managed upload volume.

## Technology stack

- Frontend: React + Vite, Tailwind CSS setup, Chart.js
- API: Node.js + Express
- Authentication: JWT, bcrypt password hashes, server-side role checks
- Database: PostgreSQL
- File uploads: Multer, type/size validation, SHA-256
- Optional OCR: Tesseract.js for image files when `ENABLE_OCR=true`
- Container setup: Docker Compose

## Run locally (recommended: Docker Desktop)

1. Install Docker Desktop and start it.
2. Extract this ZIP into a normal folder.
3. Open a terminal in the extracted `aictesih-prototype` folder.
4. Run:

   ```bash
   docker compose up --build
   ```

5. Open **http://localhost:5173** in your browser. API health check: **http://localhost:4000/api/health**.
6. Stop with `Ctrl+C`; to stop and remove the containers use `docker compose down`. Database data remains in the Docker volume. To reset demo data completely, run `docker compose down -v` (this deletes the local demo database and uploaded files).

If port 5173, 4000, or 5433 is already in use, stop the conflicting app or change the port mapping in `docker-compose.yml`.

## Demo logins

All demo accounts use password **`Demo@123`**.

| Role | Email |
|---|---|
| Institution | `institution@demo.in` |
| Regional Officer | `regional@demo.in` |
| Bureau Officer | `bureau@demo.in` |
| Committee | `committee@demo.in` |
| Administrator | `admin@demo.in` |

The database is seeded automatically on first start with one clearly synthetic sample application. A new application can be created from the Institution role.

## Suggested demo walkthrough

1. Sign in as the Institution user.
2. Create an application and note its generated reference number.
3. Open the case, upload each of the six required document types (small demo PDFs/images/TXT files), and inspect the checklist and recorded SHA-256 hashes.
4. Try submitting before all six document types exist to see the deficiency reasons; upload the missing files and submit again.
5. Sign in as the Regional Officer and forward the application to the next stage or return it with a reason.
6. Schedule an EVC visit and mark it completed.
7. Sign in as the Institution user to see alerts and status updates.
8. Use Reports and Audit Trail to show stage counts and traceable actions.
9. Sign in as Administrator to create a new version of a workflow rule.

## Included synthetic document dataset (7 PDFs)

The `dataset/sample-documents/` folder contains seven fictional PDFs aligned to the upload checklist: Application Form, Institution Registration, Land / Lease Document, Faculty Details, Infrastructure Details, Undertaking, plus an optional Compliance Evidence / EVC Note. The seventh optional document is accepted by the upload form but does not replace or count as one of the six required document types.

See `dataset/README.md` for the file-to-document-type mapping and step-by-step upload walkthrough. Create a new demo application named **Northstar Institute of Technology (Synthetic Demo)**, upload the six required files under their matching types, and upload the seventh as optional supporting evidence. For the lease-expiry demo, enter the illustrative date `2028-03-31`. All records are fictional and visibly marked as synthetic; they are not official AICTE documents.

## OCR setting

OCR is optional and disabled by default. To try image OCR in the server container, set `ENABLE_OCR=true` under the `server` service in `docker-compose.yml`, then rebuild with `docker compose up --build`. This OCR path currently runs on uploaded image files; PDF OCR, authoritative source checks, digital-signature verification and tamper detection are not implemented in this prototype. OCR output is advisory and should be checked by a person.

## Current prototype boundaries / production hardening still required

- No live AICTE API or institutional identity integration.
- No official rule pack; demo rules are not legal/regulatory guidance.
- In-app alerts work by default. Optional SMTP delivery requires a real mail provider and credentials; configure `ENABLE_EMAIL=true`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `EMAIL_FROM` for the server service in `docker-compose.yml`. Do not put real credentials in a public repository.
- The scheduler checks deadlines/expiry daily; it is a simple single-process scheduler, not a distributed job queue.
- File hashes aid traceability but do not prove that a document is genuine or untampered before upload.
- No malware scanning, antivirus, digital signature verification, authoritative source validation, encryption-at-rest policy, production-grade object storage, password reset, MFA, or formal security review.
- Sample credentials and JWT secret are for local demonstration only. Replace secrets, restrict CORS, enable TLS, and complete a security review before any deployment beyond localhost.
- Workflow transitions and rules are illustrative. A production implementation needs approved stage transitions, permission matrix, retention policy, legal review, monitoring and user acceptance testing.

## Troubleshooting

- `docker compose` is not recognised: install/update Docker Desktop, then reopen the terminal.
- Login fails: check that all three containers started; inspect logs using `docker compose logs -f server db client`.
- Database startup error: wait for PostgreSQL health check and try `docker compose up --build` again.
- Port conflict: update the host-side port mapping in `docker-compose.yml` and the `VITE_API_URL` value for the frontend if the API host port changes.
