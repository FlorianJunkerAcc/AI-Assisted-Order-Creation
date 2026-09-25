# AI-Assisted Order Creation

A prototype SAP BTP application for voice- and AI-assisted sales order entry, built with **SAP CAP**, **SAP Fiori Elements (Custom Page)**, **SAP AI Core / Generative AI Hub**, and **Anthropic Claude Sonnet**.

## Overview

Sales representatives can create customer sales orders either manually or by speaking natural-language commands such as:

> "Add 5 Ferrero Rocher and 10 Kinder Bueno"

The spoken or typed request is interpreted by an AI model, matched against real product master data, and added to an order draft for review — before the user explicitly creates the sales order.

## Key Features

- **Manual order entry**: Select a customer, add products, adjust quantities, and see live price calculations.
- **AI-assisted order entry**: A natural-language text field lets users describe products and quantities in plain English.
- **Voice input**: Browser-based speech recognition converts spoken input into text, with an animated "listening" indicator.
- **Smart product matching**: The AI model (Claude Sonnet via SAP AI Core) matches requests against the actual product catalog from the database — it never invents products, prices, or IDs.
- **Clarification dialog**: If the AI is unsure which product is meant (e.g. "Kinder"), it asks a follow-up question and offers clickable suggestions instead of guessing.
- **Human-in-the-loop confirmation**: AI-generated items are only added as a draft. The user always reviews and manually triggers the final "Create Order" action — no order is created automatically.

## Architecture

```
Voice / Text Input (Fiori)
        │
        ▼
OData V4 Action: interpretOrderItems
        │
        ▼
CAP Backend (Node.js)
  - Reads product catalog from the database
        - Reads active customers from SAP Sales Cloud V1 via the `SAP_Sales_Cloud_V1` destination
  - Calls SAP AI Core (Orchestration Service)
        │
        ▼
Claude Sonnet (via SAP AI Core / Generative AI Hub)
  - Extracts products & quantities
  - Flags ambiguous requests for clarification
        │
        ▼
CAP validates product IDs & enriches prices
        │
        ▼
Fiori order draft → user review → Create Order
```

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | SAP Cloud Application Programming Model (CAP), Node.js |
| Database | SQLite (local dev), CSV-based master data |
| Frontend | SAP Fiori Elements – Custom Page (SAPUI5, OData V4) |
| AI | SAP AI Core, Generative AI Hub, Anthropic Claude Sonnet |
| Voice | Browser Web Speech API (SpeechRecognition) |

## Project Structure

```
├── db/                         # CDS data model + CSV master data
├── srv/                        # CAP service definitions & business logic
│   ├── sales-order-service.cds # Service + interpretOrderItems action
│   └── sales-order-service.js  # AI Core integration & validation logic
└── app/salesorderui/webapp/    # Fiori custom page
    ├── ext/view/Main.view.xml       # UI layout
    ├── ext/view/Main.controller.js  # Voice input, AI calls, order logic
    └── css/style.css                # Custom styling & animations
```

## Getting Started

```bash
npm install
cds watch --profile hybrid
```

Requires a bound SAP AI Core service instance (see `.cdsrc-private.json`) with a deployed Claude Sonnet model in the Generative AI Hub.

The `SAP_Sales_Cloud_V1` destination must point to the SAP Sales Cloud tenant. The application reads `CorporateAccountCollection` from `c4codataapi` and only includes customers with `LifeCycleStatusCode = 2` and `RoleCode = CRM000`.

## Status

This is a functional proof-of-concept, not production-hardened. Authentication, error handling, and deployment configuration are simplified for demonstration purposes.
