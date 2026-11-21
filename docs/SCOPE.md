# Project scope — Healthcare / Labs

MediData implements **one industry row** from the reference table: **Healthcare / Labs**.
Nothing from banking, retail, manufacturing, or education exists in the codebase.

## The four selections

| Column                 | Our selection   | Why this one                                                                                                   |
| ---------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| **Data source**        | **EMR**         | System of record for patient demographics and encounters; highest MDM survivorship priority (`EMR > LIS > …`). |
| **Integration method** | **ETL / ELT**   | The pipeline is extract → staging → transform (ETL), then in-database SQL assets and marts (ELT).              |
| **Governance need**    | **HIPAA**       | Addressed through role-based access control, audit logging, data masking, and consent tracking.                |
| **Output**             | **Patient 360** | A single unified patient record built from the federated `gov.patient_360` view and exposed in the UI.         |

## Where each selection is implemented

| Selection   | Code / database evidence                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| EMR         | `backend/fixtures/emr/patients.json`, `emr` connector in `packages/etl-core/src/extractors/`, `SourceSystem.EMR` in the schema       |
| ETL / ELT   | `packages/etl-core/src/pipeline.ts` (extract → transform → load), `elt.ts` (`applySqlAssets`), `warehouse-loader.ts`, 3 marts        |
| HIPAA       | `apps/api/src/middleware/rbac.ts` (CASL roles), `middleware/audit.ts`, `middleware/masking.ts`, `Consent` model                      |
| Patient 360 | `packages/db/sql/warehouse_views.sql` → `gov.patient_360`, `apps/api/src/modules/patients`, `frontend/app/(dashboard)/patients/[id]` |

## Primary vs supporting

The four selections above are the **primary scope** presented in the report/slide. The
remaining items from the same healthcare row are **supporting components of the same
pipeline**, not additional scope:

| Supporting item        | Role                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| LIS                    | Supplies lab orders/results that populate Patient 360 and the DQ rules.         |
| Billing, Insurance     | Supply claims and coverage that populate Patient 360 and revenue KPIs.          |
| REST / FHIR / HL7 APIs | Interop surfaces over the same data (also how external systems connect).        |
| ISO 15189              | Lab-specific quality controls: authorized result release, controlled documents. |
| Compliance dashboards  | DQ scorecard, freshness SLAs, audit trail — evidence for the governance need.   |

## Statement to read aloud

> “Our project covers the **Healthcare / Labs** row. The primary **data source** is the
> **EMR**, integrated through **ETL/ELT**, governed to meet **HIPAA** through access control,
> audit logging, masking, and consent, and delivered as a unified **Patient 360**. LIS,
> billing, and insurance feeds plus FHIR/HL7 APIs are supporting components of the same
> pipeline.”

## Intentionally out of scope

| Item                                    | Reason                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Other industries                        | The project targets the healthcare row only.                                |
| True CDC (Debezium/logical replication) | Change events come from the transactional outbox, not database log capture. |
| Downloadable compliance PDFs            | Governance is delivered as dashboards and audit views, not report exports.  |
| Real PHI                                | All data is synthetic; the free-tier database has no BAA.                   |

## If the panel insists on exactly one item per column

The four primaries are **fully implemented**, so this document already satisfies that reading.
No code or database deletion is required: the supporting items can be described as internal
components rather than separate scope. Removing them would leave Patient 360 with only
demographics and encounters, because labs and claims come from LIS and billing.
