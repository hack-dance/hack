---
kind: linear-project-document
linearProjectId: "7a3c8adf-ede5-4d3a-8779-9c32695c76bf"
title: Web Control Plane UI System
linearId: "3980ba9d-2607-4c51-bc75-8c051d867d8e"
slug: fa12cc05df6b
archived: false
updatedAt: "2026-03-24T17:26:21.800Z"
sortOrder: 12348
---
# Web Control Plane UI System

## Required Stack

* Tailwind CSS v4
* `shadcn/ui`
* Kibo UI patterns and additional components where they improve the admin surface
* Motion for React for subtle, accessible micro-interactions

## Usage Rules

Use `shadcn/ui` as the base primitive layer. Use Kibo UI selectively for richer composed admin patterns, not as a bulk dependency dump.

Use Motion for:

* drawers, dialogs, and sheet transitions
* optimistic state changes
* small selection and emphasis transitions
* layout changes that help orientation

Do not use Motion for:

* decorative dashboard churn
* large page animations
* interactions that obscure state changes

## Accessibility Rules

* respect reduced-motion preferences
* preserve semantic structure and keyboard interaction
* keep contrast, focus states, and loading states explicit

## Design Goal

The app should feel like a calm product control plane, not a flashy demo site.