# AICTE FLOW synthetic document dataset (7 PDFs)

This folder contains seven fictional PDF files for testing the SIH 2026 prototype. They are not real institutional records and must never be submitted as genuine evidence.

## Documents

| File | Upload type in the prototype | Required? | Purpose |
|---|---|---:|---|
| `sample-documents/01_application_form.pdf` | Application Form | Yes | Application metadata and institution profile |
| `sample-documents/02_institution_registration.pdf` | Institution Registration | Yes | Registration checklist item |
| `sample-documents/03_land_lease_document.pdf` | Land / Lease Document | Yes | Lease metadata and expiry-reminder demo |
| `sample-documents/04_faculty_details.pdf` | Faculty Details | Yes | Faculty register checklist item |
| `sample-documents/05_infrastructure_details.pdf` | Infrastructure Details | Yes | Facilities checklist item |
| `sample-documents/06_undertaking.pdf` | Undertaking | Yes | Declaration checklist item |
| `sample-documents/07_compliance_evidence.pdf` | Compliance Evidence / EVC Note | No — optional | Supporting evidence for EVC/compliance workflow demos |

## How to use

1. Start the app using `docker compose up --build` from the project root.
2. Sign in with `institution@demo.in` / `Demo@123`.
3. Create a new application named **Northstar Institute of Technology (Synthetic Demo)**. The documents use the reference `AICTE-DEMO-2026-0042` as an example inside their contents; the app generates its own application reference.
4. Open the new application and upload the first six PDFs under their matching required document types.
5. Upload the seventh PDF using **Compliance Evidence / EVC Note** in the optional supporting-document section of the type selector. It does not count as a required checklist item.
6. For the Land / Lease Document, enter the illustrative expiry date **31 March 2028** in the expiry-date field to test expiry monitoring. This date is fictional and for demonstration only.
7. Verify the checklist, SHA-256 fingerprints, audit trail, notifications and workflow actions.

The sample text includes placeholders, fictional people, and deliberately unverified claims. OCR, if enabled, is advisory only; it does not establish authenticity or regulatory compliance.
