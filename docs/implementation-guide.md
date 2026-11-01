# Expendi Business: Complete Implementation Guide

This document provides a comprehensive technical blueprint for building Expendi Business, a B2B stablecoin-based financial management platform targeting African startups. The platform covers three core product areas: expense management (inspired by Expensify), crypto invoicing (inspired by Acctual), and global payroll (inspired by Deel). All three are unified by stablecoin-native settlement rails that provide faster, cheaper, and more reliable payments than traditional banking infrastructure.

---

## Table of Contents

### Part 1: Expense Management
1. [Key Concepts Explained](#key-concepts-explained)
2. [System Architecture Overview](#system-architecture-overview)
3. [Data Model Design](#data-model-design)
4. [Receipt Processing Pipeline](#receipt-processing-pipeline)
5. [Choosing an OCR Provider](#choosing-an-ocr-provider)
6. [Approval Workflow Engine](#approval-workflow-engine)
7. [Policy Engine](#policy-engine)
8. [Stablecoin Reimbursement Integration](#stablecoin-reimbursement-integration)
9. [API Design](#api-design)
10. [Mobile Receipt Capture](#mobile-receipt-capture)

### Part 2: Crypto Invoicing (Acctual-Inspired)
11. [Invoicing System Overview](#invoicing-system-overview)
12. [Invoice Data Model](#invoice-data-model)
13. [Multi-Currency Payment Acceptance](#multi-currency-payment-acceptance)
14. [Payment Detection and Settlement](#payment-detection-and-settlement)
15. [Invoice Management Features](#invoice-management-features)
16. [Invoicing API Design](#invoicing-api-design)

### Part 3: Payroll System (Deel-Inspired)
17. [Payroll System Overview](#payroll-system-overview)
18. [Contractor Management](#contractor-management)
19. [Employee Payroll](#employee-payroll)
20. [Payroll Data Model](#payroll-data-model)
21. [Compliance and Tax Handling](#compliance-and-tax-handling)
22. [Bulk Payment Processing](#bulk-payment-processing)
23. [Payroll API Design](#payroll-api-design)
24. [Kenya eTIMS Tax Integration](#kenya-etims-tax-integration)

### Part 4: Implementation
25. [Unified Platform Architecture](#unified-platform-architecture)
26. [Implementation Roadmap](#implementation-roadmap)

---

## Key Concepts Explained

Before diving into the technical implementation, it's important to understand the core technologies and concepts that power modern expense management systems.

### What is OCR (Optical Character Recognition)?

OCR stands for Optical Character Recognition. It is technology that can "read" text from images and convert it into actual text data that a computer can understand and work with.

When you take a photo of a receipt with your phone, that photo is just a collection of colored dots (pixels) to the computer. The computer doesn't inherently know that there's text in that image, or what that text says. OCR is the technology that looks at those visual patterns and figures out what characters they represent — recognizing that certain shapes spell "Coffee Shop" and "₦1,500".

**How OCR Works (Simplified):**

The process happens in four stages. First, the system performs image cleanup, improving quality by straightening tilted photos, brightening dark images, and sharpening blurry text. Second, the system identifies where text actually exists in the image, distinguishing printed text from backgrounds, logos, and decorative elements. Third, character recognition occurs where the system examines each character and compares it against patterns learned through training on millions of text examples. Finally, the system structures the recognized characters meaningfully, understanding that "Total: ₦1,500" represents an amount and "Chicken Republic" is a merchant name.

**Why OCR Accuracy Matters:**

Pure OCR typically achieves around 85% accuracy because real-world receipts are messy — they may be crumpled, faded, photographed at angles, stained, or in unusual fonts. This is why successful expense platforms like Expensify use a layered approach: OCR does initial reading, additional AI systems verify results, and difficult cases get human review. This combination achieves approximately 99% accuracy.

### What is a Workflow Engine?

A workflow engine is software that manages the sequence of steps a piece of data (like an expense report) must go through before it's complete. Think of it like a flowchart that the computer follows automatically. When an employee submits an expense report, the workflow engine determines who needs to approve it, in what order, and what happens at each step.

### What is a Policy Engine?

A policy engine evaluates data against a set of rules and determines whether it complies. For expense management, this means checking things like: Is this expense under the employee's spending limit? Is a receipt required for this amount? Is this merchant category allowed? The policy engine flags violations and can block non-compliant expenses from being submitted.

---

## System Architecture Overview

The expense management system consists of six interconnected services that handle the complete lifecycle of an expense from creation to reimbursement.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EXPENSE MANAGEMENT SYSTEM                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  Receipt Capture │     │  Expense Service │     │  Policy Engine   │    │
│  │  & Processing    │────▶│  (Core CRUD)     │────▶│  (Rules & Limits)│    │
│  │                  │     │                  │     │                  │    │
│  │  • Mobile upload │     │  • Create/edit   │     │  • Spending caps │    │
│  │  • Email forward │     │  • Categorize    │     │  • Category rules│    │
│  │  • Card auto-tx  │     │  • Attach docs   │     │  • Auto-approve  │    │
│  │  • OCR extract   │     │  • Link to card  │     │  • Violations    │    │
│  └──────────────────┘     └──────────────────┘     └──────────────────┘    │
│           │                        │                        │               │
│           │                        ▼                        │               │
│           │               ┌──────────────────┐              │               │
│           │               │  Report Service  │◀─────────────┘               │
│           │               │                  │                              │
│           │               │  • Group expenses│                              │
│           │               │  • Submit flow   │                              │
│           │               │  • Track status  │                              │
│           └──────────────▶│  • Export/sync   │                              │
│                           └──────────────────┘                              │
│                                    │                                        │
│                                    ▼                                        │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  Approval        │     │  Reimbursement   │     │  Integration     │    │
│  │  Workflow Engine │────▶│  Service         │────▶│  Service         │    │
│  │                  │     │                  │     │                  │    │
│  │  • Route to      │     │  • Calculate     │     │  • QuickBooks    │    │
│  │    approvers     │     │    amounts       │     │  • Xero          │    │
│  │  • Threshold     │     │  • Stablecoin    │     │  • Bank export   │    │
│  │    escalation    │     │    settlement    │     │  • Webhook push  │    │
│  │  • Auto-approve  │     │  • Fiat off-ramp │     │                  │    │
│  └──────────────────┘     └──────────────────┘     └──────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Service Descriptions

**Receipt Capture & Processing** handles all methods of getting expense data into the system. This includes mobile photo uploads, email forwarding (receipts@expendi.app), automatic imports from corporate card transactions, and the OCR extraction pipeline that converts receipt images into structured data.

**Expense Service** is the core CRUD (Create, Read, Update, Delete) service for expense records. It manages expense creation, editing, categorization, receipt attachment, and linking expenses to card transactions.

**Policy Engine** evaluates every expense against organization rules in real-time. It checks spending limits, category budgets, receipt requirements, expense age limits, merchant restrictions, and flags policy violations.

**Report Service** groups multiple expenses into reports for batch submission and approval. It manages report creation, expense assignment, submission workflow, and status tracking.

**Approval Workflow Engine** routes expense reports through the appropriate approval chain based on organization configuration. It handles multi-level approvals, threshold-based escalation, category-specific approvers, and auto-approval rules.

**Reimbursement Service** processes approved expenses for payment. It calculates reimbursement amounts, executes stablecoin transfers for crypto-preferring users, and initiates off-ramp transactions to local currency via mobile money or bank transfer.

**Integration Service** synchronizes expense data with external accounting systems like QuickBooks and Xero, and provides webhook notifications for custom integrations.

---

## Data Model Design

The data model forms the foundation of the expense management system. The following TypeScript interfaces define the core entities and their relationships.

### Core Expense Entity

The expense is the atomic unit of the system — a single transaction that an employee wants to track or be reimbursed for.

```typescript
// Core expense entity - represents a single expense transaction
interface Expense {
  id: string;                     // Unique identifier for this expense
  organizationId: string;         // Which company this expense belongs to
  createdById: string;            // Team member who created this expense
  
  // Financial data - the core numbers
  amount: number;                 // Amount in smallest currency unit (e.g., cents, kobo)
  currency: string;               // Original currency code (KES, NGN, USD, GHS, etc.)
  amountInUSD: number;            // Normalized to USD for consistent reporting
  exchangeRate: number;           // Exchange rate at time of transaction
  
  // Merchant & transaction details - who, what, when
  merchantName: string;           // Name of the business (e.g., "Chicken Republic")
  merchantAddress?: string;       // Optional location of the merchant
  merchantCategory: string;       // Category code (MCC) or internal category
  transactionDate: Date;          // When the purchase was made
  
  // Classification - how the expense is categorized
  categoryId: string;             // Links to spending category (e.g., "Meals", "Travel")
  tags: string[];                 // Custom tags for filtering (e.g., "Project X", "Client Y")
  isBillable: boolean;            // Can this be billed to a client?
  isReimbursable: boolean;        // Should the employee be paid back?
  
  // Receipt & documentation - proof of purchase
  receiptUrl?: string;            // URL to receipt image in cloud storage
  receiptThumbnailUrl?: string;   // Smaller preview image for faster loading
  ocrData?: OCRExtractionResult;  // Raw data extracted by OCR for audit purposes
  ocrConfidence: number;          // 0-1 score indicating how confident OCR was
  wasManuallyEdited: boolean;     // True if user corrected OCR results
  
  // Card linkage - for corporate card transactions
  cardTransactionId?: string;     // Links to the card authorization record
  cardId?: string;                // Which corporate card was used
  isCardTransaction: boolean;     // Was this paid with a corporate card?
  
  // Compliance & policy - rule checking results
  violations: PolicyViolation[];  // List of policy rules this expense violates
  requiresReceipt: boolean;       // Does this expense need a receipt attached?
  hasValidReceipt: boolean;       // Is there a valid receipt attached?
  
  // Workflow state - where is this expense in the process?
  status: ExpenseStatus;          // Current status (draft, submitted, approved, etc.)
  reportId?: string;              // Which expense report this belongs to
  
  // Stablecoin-specific fields (unique to Expendi Business)
  settlementTxHash?: string;      // Blockchain transaction hash for settlement
  bucketId?: string;              // Links to onchain spending bucket contract
  
  // Audit trail - tracking changes over time
  createdAt: Date;                // When this record was created
  updatedAt: Date;                // When this record was last modified
  submittedAt?: Date;             // When the expense was submitted for approval
  approvedAt?: Date;              // When the expense was approved
  approvedById?: string;          // Who approved this expense
}

// Possible statuses an expense can have as it moves through the system
type ExpenseStatus = 
  | 'draft'           // Just created, not yet submitted
  | 'pending_receipt' // Submitted but waiting for receipt attachment
  | 'submitted'       // In the approval queue waiting for review
  | 'approved'        // Approved by all required approvers
  | 'rejected'        // Rejected by an approver
  | 'reimbursed'      // Payment has been sent to the employee
  | 'exported';       // Synced to external accounting system

// Represents a policy rule that an expense violates
interface PolicyViolation {
  type: ViolationType;            // What kind of violation this is
  message: string;                // Human-readable explanation
  severity: 'warning' | 'blocking'; // Warning = flag but allow, Blocking = prevent submission
  autoResolved: boolean;          // Was this violation automatically fixed?
}

// Types of policy violations the system can detect
type ViolationType = 
  | 'over_limit'              // Expense exceeds category or personal spending limit
  | 'missing_receipt'         // Receipt is required but not attached
  | 'duplicate_suspected'     // This looks like a duplicate of another expense
  | 'restricted_merchant'     // Purchases from this merchant category aren't allowed
  | 'expense_too_old'         // Transaction is too old to submit (outside time window)
  | 'budget_exceeded'         // This would push the category over its budget
  | 'requires_approval';      // Amount is above the auto-approve threshold
```

### Expense Report Entity

Expense reports group multiple expenses together for batch approval and reimbursement.

```typescript
// Expense report - groups multiple expenses for batch processing
interface ExpenseReport {
  id: string;                     // Unique identifier for this report
  organizationId: string;         // Which company this report belongs to
  submittedById: string;          // Team member who created and submitted this report
  
  // Report identification
  title: string;                  // Report name (auto-generated or custom)
  description?: string;           // Optional notes about this report
  
  // Aggregated totals - calculated from included expenses
  expenseIds: string[];           // List of expense IDs included in this report
  totalAmount: number;            // Sum of all expense amounts
  totalAmountUSD: number;         // Sum normalized to USD
  expenseCount: number;           // Number of expenses in this report
  
  // Workflow tracking
  status: ReportStatus;           // Current status in the approval process
  currentApproverId?: string;     // Who currently needs to review this report
  approvalPath: string[];         // Ordered list of approvers this report must go through
  approvalHistory: ApprovalAction[]; // Record of all approval actions taken
  
  // Date tracking
  periodStart: Date;              // Earliest expense date in the report
  periodEnd: Date;                // Latest expense date in the report
  createdAt: Date;                // When the report was created
  submittedAt?: Date;             // When it was submitted for approval
  approvedAt?: Date;              // When final approval was given
  
  // Reimbursement tracking
  reimbursementStatus?: 'pending' | 'processing' | 'completed';
  reimbursementTxHash?: string;   // Blockchain transaction hash for payment
}

// Possible statuses for an expense report
type ReportStatus = 
  | 'draft'             // Being prepared, not yet submitted
  | 'submitted'         // Just submitted, entering approval workflow
  | 'pending_approval'  // Waiting for current approver to review
  | 'approved'          // All approvals complete
  | 'rejected'          // Rejected by an approver
  | 'reimbursed';       // Payment has been processed

// Record of an approval action taken on a report
interface ApprovalAction {
  approverId: string;             // Who took this action
  action: 'approve' | 'reject' | 'forward' | 'return'; // What they did
  comment?: string;               // Optional explanation
  timestamp: Date;                // When the action was taken
}
```

### OCR Extraction Result

This structure holds the data extracted from a receipt image by the OCR system.

```typescript
// Results from OCR processing of a receipt image
interface OCRExtractionResult {
  merchantName: string;           // Business name extracted from receipt
  merchantAddress?: string;       // Business address if present
  date: string;                   // Transaction date (ISO format: YYYY-MM-DD)
  total: number;                  // Total amount paid
  subtotal?: number;              // Amount before tax/tip if shown
  tax?: number;                   // Tax amount if shown separately
  tip?: number;                   // Tip amount if applicable
  currency: string;               // Currency code detected
  lineItems: LineItem[];          // Individual items purchased
  paymentMethod?: string;         // How payment was made (cash, card, etc.)
  confidence: number;             // 0-1 overall confidence score
  rawText: string;                // Full text extracted (for debugging/audit)
}

// Individual item on a receipt
interface LineItem {
  description: string;            // Item name or description
  quantity?: number;              // Number of items (if shown)
  unitPrice?: number;             // Price per unit (if shown)
  totalPrice: number;             // Total price for this line
}
```

---

## Receipt Processing Pipeline

The receipt processing pipeline handles converting receipt images into structured expense data. Following Expensify's approach, the pipeline uses multiple layers to achieve high accuracy rather than relying on OCR alone.

### Pipeline Architecture

```typescript
// Receipt processing pipeline - handles all methods of receipt ingestion
class ReceiptProcessor {
  private ocrProvider: OCRProvider;        // Primary OCR service (Taggun, Mindee, etc.)
  private llmProvider: LLMProvider;        // AI fallback for complex receipts
  private parserRegistry: ParserRegistry;  // Template parsers for known receipt formats
  
  /**
   * Main entry point for processing a receipt image.
   * Uses a layered approach: template matching → OCR → AI verification
   * to achieve the highest possible accuracy.
   */
  async processReceipt(input: ReceiptInput): Promise<ProcessingResult> {
    
    // Step 1: Image preprocessing
    // Clean up the image to improve OCR accuracy
    const preprocessed = await this.preprocessImage(input.imageData);
    
    // Step 2: Check if this matches a known receipt format
    // Common receipts (Uber, Amazon, airline tickets, etc.) have consistent
    // formats that we can parse with high accuracy using templates
    const knownFormat = await this.parserRegistry.matchFormat(preprocessed);
    
    if (knownFormat) {
      // Fast path: use template parser for known formats
      // These achieve ~98% accuracy because the format is predictable
      const extracted = await knownFormat.parser.extract(preprocessed);
      return {
        data: extracted,
        confidence: 0.98,
        method: 'template_parser',
        requiresReview: false
      };
    }
    
    // Step 3: Primary OCR extraction
    // For unknown receipt formats, use the OCR provider
    const ocrResult = await this.ocrProvider.extract(preprocessed);
    
    // Step 4: Confidence-based routing
    // Route the result based on how confident the OCR is
    
    if (ocrResult.confidence >= 0.90) {
      // High confidence (90%+): Auto-accept the results
      // The OCR is very sure about what it read
      return {
        data: this.normalizeOCRResult(ocrResult),
        confidence: ocrResult.confidence,
        method: 'ocr_auto',
        requiresReview: false
      };
    }
    
    if (ocrResult.confidence >= 0.70) {
      // Medium confidence (70-90%): Use AI to verify and correct
      // The OCR might have made some mistakes, so we double-check
      const llmVerified = await this.verifyWithLLM(preprocessed, ocrResult);
      return {
        data: llmVerified.data,
        confidence: llmVerified.confidence,
        method: 'ocr_llm_verified',
        requiresReview: llmVerified.confidence < 0.85
      };
    }
    
    // Low confidence (below 70%): Flag for manual review
    // The receipt is too unclear for automated processing
    return {
      data: this.normalizeOCRResult(ocrResult),
      confidence: ocrResult.confidence,
      method: 'ocr_low_confidence',
      requiresReview: true,
      reviewReason: 'Low OCR confidence - manual verification recommended'
    };
  }
  
  /**
   * Preprocesses the receipt image to improve OCR accuracy.
   * Applies various image corrections like straightening, contrast
   * enhancement, and noise reduction.
   */
  private async preprocessImage(imageData: Buffer): Promise<PreprocessedImage> {
    // Using the 'sharp' library for image processing
    const processed = await sharp(imageData)
      .normalize()           // Enhance contrast automatically
      .sharpen()             // Improve text clarity
      .grayscale()           // Convert to grayscale (improves OCR)
      .toBuffer();
    
    return {
      original: imageData,
      processed,
      metadata: await sharp(imageData).metadata()
    };
  }
  
  /**
   * Uses a vision-capable AI model to verify and correct OCR results.
   * The AI can see the actual receipt image and compare it against
   * what the OCR extracted, catching errors that pure OCR misses.
   */
  private async verifyWithLLM(
    image: PreprocessedImage, 
    ocrResult: OCRExtractionResult
  ): Promise<LLMVerificationResult> {
    
    const prompt = `
      I have a receipt image and OCR extraction results.
      Please verify the extracted data and correct any errors.
      
      OCR extracted:
      - Merchant: ${ocrResult.merchantName}
      - Date: ${ocrResult.date}
      - Total: ${ocrResult.total} ${ocrResult.currency}
      - Items: ${JSON.stringify(ocrResult.lineItems)}
      
      Please return corrected JSON with:
      {
        "merchantName": "...",
        "merchantAddress": "...",
        "date": "YYYY-MM-DD",
        "total": number,
        "currency": "...",
        "lineItems": [...],
        "corrections": ["list of corrections made"],
        "confidence": 0.0-1.0
      }
    `;
    
    // Send the image and prompt to the AI model
    const response = await this.llmProvider.analyzeImage(
      image.processed,
      prompt,
      { responseFormat: 'json' }
    );
    
    return JSON.parse(response);
  }
  
  /**
   * Normalizes OCR results into a consistent format.
   * Different OCR providers return data in slightly different formats,
   * so this ensures consistency for downstream processing.
   */
  private normalizeOCRResult(ocrResult: any): OCRExtractionResult {
    return {
      merchantName: ocrResult.merchantName || ocrResult.vendor || 'Unknown',
      merchantAddress: ocrResult.merchantAddress || ocrResult.address,
      date: this.parseDate(ocrResult.date),
      total: parseFloat(ocrResult.total) || 0,
      subtotal: ocrResult.subtotal ? parseFloat(ocrResult.subtotal) : undefined,
      tax: ocrResult.tax ? parseFloat(ocrResult.tax) : undefined,
      tip: ocrResult.tip ? parseFloat(ocrResult.tip) : undefined,
      currency: ocrResult.currency || 'USD',
      lineItems: ocrResult.lineItems || [],
      paymentMethod: ocrResult.paymentMethod,
      confidence: ocrResult.confidence || 0.5,
      rawText: ocrResult.rawText || ''
    };
  }
}

// Interface that OCR providers must implement
interface OCRProvider {
  extract(image: PreprocessedImage): Promise<OCRExtractionResult>;
}

// Input for receipt processing
interface ReceiptInput {
  imageData: Buffer;              // Raw image data
  mimeType: string;               // Image type (image/jpeg, image/png, etc.)
  source: 'mobile_upload' | 'email_forward' | 'web_upload';
}

// Result of receipt processing
interface ProcessingResult {
  data: OCRExtractionResult;      // Extracted data
  confidence: number;             // Overall confidence score
  method: string;                 // Which processing method was used
  requiresReview: boolean;        // Should a human verify this?
  reviewReason?: string;          // Why review is needed (if applicable)
}
```

---

## Choosing an OCR Provider

Based on extensive research, here are the recommended OCR providers ranked by suitability for expense management in African markets.

### Tier 1: Recommended for Production

**Taggun** is used by Ramp and specializes exclusively in receipts rather than general documents. It supports 50+ countries including African receipt formats, handles multiple languages, and provides structured JSON output with confidence scores per field. Pricing starts around $0.02-0.05 per receipt depending on volume. This is the recommended choice for production use.

**Mindee** offers a free tier for testing and development, making it excellent for getting started quickly. It claims 90%+ accuracy, provides good line-item extraction, and offers SDKs for Python and JavaScript. Processing time is approximately 1 second per receipt. Particularly strong at handling poor quality images common with mobile phone cameras.

**Veryfi** is enterprise-focused with the highest accuracy claims in the industry. It handles handwriting well, which is useful for tip amounts common on African receipts. More expensive than alternatives but includes built-in fraud detection. Best suited for organizations processing high volumes where accuracy is critical.

### Tier 2: Good Alternatives

**Azure Document Intelligence** (Microsoft) is very reliable with excellent multi-language support. It uses pay-per-page pricing and integrates well with Azure-based infrastructure. Good choice if already using Microsoft cloud services.

**Google Cloud Vision** is powerful general OCR but requires more post-processing to structure receipt data. Offers good value at scale and is ideal for building custom parsers for specific receipt formats.

### Tier 3: Self-Hosted Option

**LLM-based approach** uses vision-capable models like GPT-4V, Claude, or Gemini directly. This offers lower cost at scale with more flexibility, but requires prompt engineering expertise. Good for fallback processing of difficult receipts.

### Recommended Strategy for Expendi Business

Start with Mindee for initial development (free tier allows testing without cost). Implement an LLM fallback for low-confidence results using Claude or GPT-4V. As volume grows, evaluate Taggun for higher accuracy needs. Build template parsers for common receipt formats (Uber, Bolt, major African retailers) to achieve near-perfect accuracy on frequently-seen receipts.

---

## Approval Workflow Engine

The approval workflow engine routes expense reports through the appropriate approval chain based on organization configuration, member roles, expense amounts, and categories.

### Workflow Configuration

```typescript
// Configuration for how expense reports are routed and approved
interface ApprovalWorkflowConfig {
  organizationId: string;
  
  // Basic workflow mode selection
  mode: 'submit_and_close' | 'submit_and_approve' | 'advanced_approval';
  // submit_and_close: Reports auto-approve (for orgs where approval happens outside system)
  // submit_and_approve: All reports go to a single designated approver
  // advanced_approval: Multi-level approval with different approvers at each level
  
  enforceWorkflow: boolean;       // If true, users cannot bypass the configured workflow
  
  // Auto-approval rules for low-risk expenses
  autoApprove: {
    enabled: boolean;             // Is auto-approval turned on?
    maxAmount: number;            // Auto-approve expenses under this USD amount
    auditPercentage: number;      // Randomly audit this percentage of auto-approved reports
  };
  
  // Custom rules that apply to all expenses
  rules: ExpenseRule[];
  
  // Category-specific approvers (e.g., "Travel" expenses go to Travel Manager)
  categoryApprovers: Map<string, string>;  // categoryId → approverId
  
  // Tag-specific approvers (e.g., "Client: Acme" expenses go to Account Manager)
  tagApprovers: Map<string, string>;       // tag → approverId
}

// Settings specific to each organization member
interface MemberApprovalSettings {
  memberId: string;
  submitsTo: string;              // Default approver for this member's reports
  approvesTo?: string;            // Who this member forwards reports to after approving
  overLimitThreshold?: number;    // Amount that triggers escalation to secondary approver
  overLimitApprover?: string;     // Secondary approver for high-value reports
}

// Custom rule that can be applied to expenses
interface ExpenseRule {
  id: string;
  name: string;                   // Human-readable name (e.g., "Require receipt over $25")
  conditions: RuleCondition[];    // Conditions that trigger this rule
  action: RuleAction;             // What happens when rule is triggered
  priority: number;               // Lower numbers = higher priority
}

// Condition for rule evaluation
interface RuleCondition {
  field: 'amount' | 'category' | 'merchant' | 'age_days' | 'has_receipt';
  operator: 'eq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'not_in' | 'contains';
  value: any;
}

// Action to take when a rule is triggered
type RuleAction = 
  | { type: 'flag_violation'; violation: ViolationType; severity: 'warning' | 'blocking' }
  | { type: 'require_receipt' }
  | { type: 'route_to_approver'; approverId: string }
  | { type: 'auto_approve' }
  | { type: 'block_submission'; reason: string };
```

### Workflow Engine Implementation

```typescript
// The engine that processes expense reports through the approval workflow
class ApprovalWorkflowEngine {
  
  /**
   * Processes a newly submitted expense report.
   * Validates all expenses, determines the approval path,
   * and routes to the first approver (or auto-approves if eligible).
   */
  async processSubmission(report: ExpenseReport): Promise<WorkflowResult> {
    // Load organization's workflow configuration
    const config = await this.getWorkflowConfig(report.organizationId);
    // Load submitter's specific approval settings
    const submitter = await this.getMemberSettings(report.submittedById);
    
    // Step 1: Validate all expenses against organization rules
    const validationResults = await this.validateExpenses(report, config);
    
    // Check for blocking violations that prevent submission
    const blockingViolations = validationResults
      .flatMap(r => r.violations)
      .filter(v => v.severity === 'blocking');
    
    if (blockingViolations.length > 0) {
      // Cannot proceed - return the report with violation details
      return {
        status: 'blocked',
        reason: 'Report contains blocking policy violations',
        violations: blockingViolations
      };
    }
    
    // Step 2: Determine the approval path for this report
    const approvalPath = this.determineApprovalPath(report, config, submitter);
    
    // Step 3: Check if this report qualifies for auto-approval
    if (this.canAutoApprove(report, config)) {
      // Perform random audit check
      const shouldAudit = Math.random() < config.autoApprove.auditPercentage / 100;
      
      if (shouldAudit) {
        // Selected for random audit - send to approver despite being auto-eligible
        return {
          status: 'pending_audit',
          currentApprover: approvalPath[0],
          reason: 'Selected for random audit'
        };
      }
      
      // Auto-approve without human review
      return {
        status: 'auto_approved',
        reason: `Total $${report.totalAmountUSD} under auto-approve threshold`
      };
    }
    
    // Step 4: Route to the first approver in the chain
    return {
      status: 'pending_approval',
      currentApprover: approvalPath[0],
      approvalPath,
      violations: validationResults.flatMap(r => r.violations)
    };
  }
  
  /**
   * Determines the ordered list of approvers for a report.
   * Takes into account the submitter's default approver, threshold-based
   * escalation, and category/tag-specific approvers.
   */
  private determineApprovalPath(
    report: ExpenseReport,
    config: ApprovalWorkflowConfig,
    submitter: MemberApprovalSettings
  ): string[] {
    const path: string[] = [];
    
    // Start with the submitter's default approver (usually their manager)
    if (submitter.submitsTo) {
      path.push(submitter.submitsTo);
    }
    
    // Check if report total exceeds the threshold for secondary approval
    // This ensures high-value reports get extra scrutiny
    if (submitter.overLimitThreshold && 
        report.totalAmountUSD > submitter.overLimitThreshold &&
        submitter.overLimitApprover) {
      path.push(submitter.overLimitApprover);
    }
    
    // Add category-specific approvers if configured
    // For example, all "Travel" expenses might need approval from a Travel Manager
    const expenseCategories = new Set(
      report.expenses.map(e => e.categoryId)
    );
    
    for (const categoryId of expenseCategories) {
      const categoryApprover = config.categoryApprovers.get(categoryId);
      if (categoryApprover && !path.includes(categoryApprover)) {
        // Insert category approver before the final approver
        path.splice(path.length - 1, 0, categoryApprover);
      }
    }
    
    return path;
  }
  
  /**
   * Checks if a report is eligible for automatic approval.
   * Reports can be auto-approved if they're under the threshold amount,
   * have no missing receipts, and have no blocking violations.
   */
  private canAutoApprove(
    report: ExpenseReport, 
    config: ApprovalWorkflowConfig
  ): boolean {
    // Auto-approval must be enabled
    if (!config.autoApprove.enabled) return false;
    
    // Report total must be under the threshold
    if (report.totalAmountUSD > config.autoApprove.maxAmount) return false;
    
    // All required receipts must be attached
    const missingReceipts = report.expenses
      .filter(e => e.requiresReceipt && !e.hasValidReceipt);
    if (missingReceipts.length > 0) return false;
    
    // No blocking policy violations
    const hasBlockingViolations = report.expenses
      .some(e => e.violations.some(v => v.severity === 'blocking'));
    if (hasBlockingViolations) return false;
    
    return true;
  }
  
  /**
   * Handles an approver's action on a report.
   * Approvers can approve (move to next approver or complete),
   * reject (end the workflow), or return (send back for corrections).
   */
  async handleApproverAction(
    reportId: string,
    approverId: string,
    action: 'approve' | 'reject' | 'return',
    comment?: string
  ): Promise<WorkflowResult> {
    const report = await this.getReport(reportId);
    const config = await this.getWorkflowConfig(report.organizationId);
    
    // Record this action in the approval history
    await this.recordApprovalAction(report, approverId, action, comment);
    
    if (action === 'reject') {
      // Rejection ends the workflow - report goes back to submitter
      return { status: 'rejected', reason: comment };
    }
    
    if (action === 'return') {
      // Return sends the report back to the submitter for corrections
      // without fully rejecting it
      return { status: 'returned', reason: comment };
    }
    
    // Action is 'approve' - check if there are more approvers in the chain
    const currentIndex = report.approvalPath.indexOf(approverId);
    const nextApprover = report.approvalPath[currentIndex + 1];
    
    if (nextApprover) {
      // Route to the next approver in the chain
      return {
        status: 'pending_approval',
        currentApprover: nextApprover
      };
    }
    
    // No more approvers - this was the final approval
    return { status: 'approved' };
  }
}

// Result of a workflow operation
interface WorkflowResult {
  status: 'blocked' | 'pending_approval' | 'pending_audit' | 
          'auto_approved' | 'approved' | 'rejected' | 'returned';
  currentApprover?: string;
  approvalPath?: string[];
  reason?: string;
  violations?: PolicyViolation[];
}
```

---

## Policy Engine

The policy engine evaluates expenses against organization rules in real-time, flagging violations and enforcing compliance.

```typescript
// Engine that evaluates expenses against organization policies
class PolicyEngine {
  
  /**
   * Evaluates a single expense against all applicable policies.
   * Returns a list of any violations found.
   */
  async evaluateExpense(
    expense: Expense,
    organizationId: string
  ): Promise<PolicyEvaluationResult> {
    // Load all policies for this organization
    const policies = await this.getOrganizationPolicies(organizationId);
    // Load the member who created this expense
    const member = await this.getMember(expense.createdById);
    const violations: PolicyViolation[] = [];
    
    // Check 1: Personal spending limit
    // Each member may have a maximum they can spend per day
    if (expense.amount > member.dailyLimit) {
      violations.push({
        type: 'over_limit',
        message: `Expense exceeds your daily limit of ${member.dailyLimit}`,
        severity: 'blocking'
      });
    }
    
    // Check 2: Category budget
    // Categories (like "Travel" or "Meals") may have monthly budgets
    const category = await this.getCategory(expense.categoryId);
    const monthlySpent = await this.getCategorySpendThisMonth(
      organizationId, 
      expense.categoryId
    );
    
    if (category.monthlyBudget && 
        monthlySpent + expense.amount > category.monthlyBudget) {
      violations.push({
        type: 'budget_exceeded',
        message: `This expense would exceed the ${category.name} monthly budget`,
        severity: policies.blockOverBudget ? 'blocking' : 'warning'
      });
    }
    
    // Check 3: Receipt requirement
    // Expenses over a certain amount typically require a receipt
    const receiptThreshold = category.requireReceiptOver ?? policies.defaultReceiptThreshold;
    if (expense.amount >= receiptThreshold && !expense.hasValidReceipt) {
      violations.push({
        type: 'missing_receipt',
        message: `Receipt required for expenses over ${receiptThreshold}`,
        severity: 'blocking'
      });
    }
    
    // Check 4: Expense age
    // Very old expenses shouldn't be submitted (prevents abuse)
    const ageInDays = this.daysBetween(expense.transactionDate, new Date());
    if (ageInDays > policies.maxExpenseAgeDays) {
      violations.push({
        type: 'expense_too_old',
        message: `Expense is ${ageInDays} days old. Maximum allowed is ${policies.maxExpenseAgeDays} days`,
        severity: 'blocking'
      });
    }
    
    // Check 5: Merchant category restrictions
    // Some organizations block certain types of purchases (gambling, alcohol, etc.)
    if (policies.restrictedMerchantCategories.includes(expense.merchantCategory)) {
      violations.push({
        type: 'restricted_merchant',
        message: `Purchases from ${expense.merchantCategory} merchants are not allowed`,
        severity: 'blocking'
      });
    }
    
    // Check 6: Duplicate detection
    // Look for expenses with the same amount, merchant, and date
    const possibleDuplicate = await this.findPossibleDuplicate(expense);
    if (possibleDuplicate) {
      violations.push({
        type: 'duplicate_suspected',
        message: `This may be a duplicate of expense ${possibleDuplicate.id}`,
        severity: 'warning'  // Warning only - user can confirm it's not a duplicate
      });
    }
    
    // Check 7: Custom rules defined by the organization
    for (const rule of policies.customRules) {
      const ruleResult = await this.evaluateRule(rule, expense);
      if (ruleResult.triggered) {
        violations.push(...ruleResult.violations);
      }
    }
    
    return {
      expense,
      violations,
      isCompliant: violations.filter(v => v.severity === 'blocking').length === 0,
      requiresReceipt: expense.amount >= receiptThreshold
    };
  }
  
  /**
   * Searches for potential duplicate expenses.
   * Looks for expenses with the same amount and merchant within a day of this expense.
   */
  private async findPossibleDuplicate(expense: Expense): Promise<Expense | null> {
    const candidates = await this.db.expenses.findMany({
      where: {
        organizationId: expense.organizationId,
        id: { not: expense.id },  // Exclude this expense itself
        amount: expense.amount,    // Same amount
        merchantName: { 
          contains: expense.merchantName.substring(0, 10),  // Similar merchant name
          mode: 'insensitive'
        },
        transactionDate: {
          gte: new Date(expense.transactionDate.getTime() - 86400000), // -1 day
          lte: new Date(expense.transactionDate.getTime() + 86400000)  // +1 day
        }
      }
    });
    
    return candidates[0] ?? null;
  }
  
  /**
   * Calculates the number of days between two dates.
   */
  private daysBetween(date1: Date, date2: Date): number {
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.floor(Math.abs(date2.getTime() - date1.getTime()) / msPerDay);
  }
}

// Result of policy evaluation
interface PolicyEvaluationResult {
  expense: Expense;
  violations: PolicyViolation[];
  isCompliant: boolean;           // True if no blocking violations
  requiresReceipt: boolean;       // Does this expense need a receipt?
}
```

---

## Stablecoin Reimbursement Integration

This is where Expendi Business differentiates from traditional expense management — integrating stablecoin payments for fast, low-cost reimbursements.

```typescript
// Service that handles paying employees back for approved expenses
class ReimbursementService {
  private walletService: WalletService;        // Handles onchain transactions
  private offRampProvider: OffRampProvider;    // Yellow Card, Kotani Pay, etc.
  
  /**
   * Processes reimbursement for an approved expense report.
   * Can pay in stablecoins directly or off-ramp to local currency.
   */
  async processReimbursement(report: ExpenseReport): Promise<ReimbursementResult> {
    const organization = await this.getOrganization(report.organizationId);
    const recipient = await this.getMember(report.submittedById);
    
    // Calculate total amount to reimburse
    const reimbursableExpenses = report.expenses
      .filter(e => e.isReimbursable && e.status === 'approved');
    
    const totalUSD = reimbursableExpenses
      .reduce((sum, e) => sum + e.amountInUSD, 0);
    
    // Route based on recipient's preference
    if (recipient.preferStablecoinReimbursement) {
      // Direct USDC transfer to recipient's wallet
      // Fast, low cost, but requires recipient to have crypto wallet
      return this.reimburseInStablecoin(report, recipient, totalUSD);
    } else {
      // Off-ramp to local currency via mobile money or bank transfer
      // More familiar for users, but takes longer and has fees
      return this.reimburseInLocalCurrency(report, recipient, totalUSD);
    }
  }
  
  /**
   * Sends reimbursement directly in USDC stablecoin.
   * This is instant and very low cost (just gas fees on Base).
   */
  private async reimburseInStablecoin(
    report: ExpenseReport,
    recipient: Member,
    amountUSD: number
  ): Promise<ReimbursementResult> {
    
    // Execute onchain transfer from organization wallet to recipient
    const txHash = await this.walletService.executeTransfer({
      from: report.organizationId,
      to: recipient.walletAddress,
      amount: amountUSD * 1e6,    // USDC uses 6 decimal places
      token: 'USDC',
      memo: `Reimbursement for report ${report.id}`
    });
    
    return {
      status: 'completed',
      method: 'stablecoin',
      amount: amountUSD,
      currency: 'USDC',
      txHash,
      settledAt: new Date()
    };
  }
  
  /**
   * Sends reimbursement by converting to local currency.
   * Uses off-ramp providers like Yellow Card or Kotani Pay to send
   * money to mobile money wallets or bank accounts.
   */
  private async reimburseInLocalCurrency(
    report: ExpenseReport,
    recipient: Member,
    amountUSD: number
  ): Promise<ReimbursementResult> {
    
    // Get recipient's preferred withdrawal method and local currency
    const withdrawalMethod = recipient.preferredWithdrawalMethod;
    const localCurrency = recipient.localCurrency;  // KES, NGN, GHS, etc.
    
    // Get current exchange rate from the off-ramp provider
    const exchangeRate = await this.offRampProvider.getRate('USDC', localCurrency);
    const localAmount = amountUSD * exchangeRate.rate;
    
    // Initiate the off-ramp transaction
    const offRampResult = await this.offRampProvider.initiateWithdrawal({
      amountUSD,
      recipientCurrency: localCurrency,
      recipientAmount: localAmount,
      method: withdrawalMethod,  // 'mobile_money' or 'bank_transfer'
      recipientDetails: {
        phone: recipient.phone,              // For mobile money (M-Pesa, MTN, etc.)
        bankAccount: recipient.bankAccount,  // For bank transfer
        bankCode: recipient.bankCode
      }
    });
    
    return {
      status: 'processing',       // Off-ramp takes time to settle
      method: withdrawalMethod,
      amount: localAmount,
      currency: localCurrency,
      offRampReference: offRampResult.reference,
      estimatedArrival: offRampResult.estimatedArrival
    };
  }
}

// Result of a reimbursement operation
interface ReimbursementResult {
  status: 'completed' | 'processing' | 'failed';
  method: 'stablecoin' | 'mobile_money' | 'bank_transfer';
  amount: number;
  currency: string;
  txHash?: string;                 // For stablecoin payments
  offRampReference?: string;       // For off-ramp payments
  estimatedArrival?: Date;         // When funds will arrive
  settledAt?: Date;                // When payment completed
  error?: string;                  // If status is 'failed'
}
```

---

## API Design

The REST API exposes all expense management functionality to the web and mobile applications.

### Expense Endpoints

```
POST   /api/v1/expenses                    Create a new expense
GET    /api/v1/expenses                    List expenses (with filters)
GET    /api/v1/expenses/:id                Get expense details
PATCH  /api/v1/expenses/:id                Update an expense
DELETE /api/v1/expenses/:id                Delete a draft expense
```

### Receipt Processing Endpoints

```
POST   /api/v1/receipts/scan               Upload and OCR a receipt image
POST   /api/v1/receipts/email-forward      Webhook endpoint for email forwarding
GET    /api/v1/receipts/:id/status         Check OCR processing status
```

### Report Endpoints

```
POST   /api/v1/reports                     Create a new expense report
GET    /api/v1/reports                     List reports (with filters)
GET    /api/v1/reports/:id                 Get report details
POST   /api/v1/reports/:id/submit          Submit report for approval
POST   /api/v1/reports/:id/expenses        Add expenses to a report
DELETE /api/v1/reports/:id/expenses/:eid   Remove expense from report
```

### Approval Endpoints

```
GET    /api/v1/approvals/pending           Get pending approvals for current user
POST   /api/v1/approvals/:reportId/approve Approve a report
POST   /api/v1/approvals/:reportId/reject  Reject a report
POST   /api/v1/approvals/:reportId/return  Return report for corrections
```

### Policy & Category Endpoints

```
GET    /api/v1/categories                  List expense categories
POST   /api/v1/categories                  Create a category (admin only)
PATCH  /api/v1/categories/:id              Update a category (admin only)
GET    /api/v1/policies                    Get organization policies
PATCH  /api/v1/policies                    Update policies (admin only)
POST   /api/v1/policies/evaluate           Evaluate an expense against policies
```

### Reimbursement Endpoints

```
GET    /api/v1/reimbursements              List reimbursements
POST   /api/v1/reimbursements/:reportId    Initiate reimbursement for approved report
GET    /api/v1/reimbursements/:id/status   Check reimbursement status
```

### Integration Endpoints

```
POST   /api/v1/integrations/quickbooks/connect    Connect QuickBooks account
POST   /api/v1/integrations/quickbooks/sync       Sync data to QuickBooks
POST   /api/v1/integrations/xero/connect          Connect Xero account
POST   /api/v1/integrations/xero/sync             Sync data to Xero
GET    /api/v1/integrations/status                Check all integration statuses
```

---

## Mobile Receipt Capture

The mobile experience is critical for expense management. Employees need to capture receipts quickly and easily, often immediately after a purchase.

```typescript
// React Native component for capturing receipts (simplified example)
import React, { useState } from 'react';
import { View, TouchableOpacity, Text, ActivityIndicator } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

const ReceiptCapture = ({ navigation }) => {
  const [processing, setProcessing] = useState(false);
  
  /**
   * Opens the camera for receipt capture and processes the result.
   */
  const captureReceipt = async () => {
    // Launch the device camera with settings optimized for receipts
    const photo = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,        // Good quality but not too large for fast upload
      allowsEditing: true, // Let user crop if needed
    });
    
    // User cancelled
    if (photo.canceled) return;
    
    // Process the captured image
    await processReceipt(photo.assets[0]);
  };
  
  /**
   * Uploads the receipt image to the server for OCR processing.
   */
  const processReceipt = async (image) => {
    setProcessing(true);
    
    try {
      // Create form data for upload
      const formData = new FormData();
      formData.append('receipt', {
        uri: image.uri,
        type: 'image/jpeg',
        name: 'receipt.jpg',
      });
      
      // Upload to backend OCR endpoint
      const response = await api.post('/receipts/scan', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      
      const result = response.data;
      
      // Check confidence level and route appropriately
      if (result.confidence >= 0.90) {
        // High confidence: auto-create draft expense and show success
        await createDraftExpense(result);
        showToast('Expense created! Review and submit when ready.');
        navigation.navigate('ExpenseList');
      } else {
        // Lower confidence: show extracted data for user to review/correct
        navigation.navigate('ReviewExtraction', { 
          extraction: result,
          receiptUrl: result.receiptUrl
        });
      }
    } catch (error) {
      showError('Failed to process receipt. Please try again or enter manually.');
    } finally {
      setProcessing(false);
    }
  };
  
  /**
   * Creates a draft expense from OCR results.
   */
  const createDraftExpense = async (ocrResult) => {
    await api.post('/expenses', {
      merchantName: ocrResult.merchantName,
      amount: ocrResult.total,
      currency: ocrResult.currency,
      transactionDate: ocrResult.date,
      categoryId: await suggestCategory(ocrResult.merchantName),
      receiptUrl: ocrResult.receiptUrl,
      ocrData: ocrResult,
      ocrConfidence: ocrResult.confidence,
      status: 'draft'
    });
  };
  
  return (
    <View style={styles.container}>
      <TouchableOpacity 
        style={styles.captureButton}
        onPress={captureReceipt}
        disabled={processing}
      >
        {processing ? (
          <ActivityIndicator color="white" size="large" />
        ) : (
          <>
            <CameraIcon size={48} color="white" />
            <Text style={styles.buttonText}>Scan Receipt</Text>
          </>
        )}
      </TouchableOpacity>
      
      <Text style={styles.hint}>
        Tap to photograph a receipt. We'll extract the details automatically.
      </Text>
    </View>
  );
};
```

---

# Part 2: Crypto Invoicing (Acctual-Inspired)

This section covers the crypto invoicing system, inspired by Acctual's flexible B2B payment platform. The key innovation is allowing businesses to send invoices where the payer can choose their preferred payment method (fiat or crypto) while the recipient receives funds in their preferred format.

---

## Invoicing System Overview

The invoicing system enables African startups to get paid faster by international clients. Traditional cross-border payments to Africa can take 1-2 weeks and cost 5-10% in fees. With stablecoin invoicing, payments settle in minutes at a fraction of the cost.

### Core Value Proposition

The system solves three critical problems for African businesses. First, payment flexibility allows clients to pay in USD, EUR, or stablecoins (USDC, USDT) while the business receives funds however they prefer. Second, same-day settlement means no more waiting weeks for international wire transfers. Third, lower fees of around 1% replace the typical 5-10% lost to bank fees and poor exchange rates.

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INVOICING SYSTEM                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  Invoice Builder │     │  Payment Gateway │     │  Settlement      │    │
│  │                  │────▶│                  │────▶│  Engine          │    │
│  │  • Line items    │     │  • Fiat rails    │     │                  │    │
│  │  • Multi-currency│     │  • Crypto rails  │     │  • Currency swap │    │
│  │  • Custom branding│    │  • Card payments │     │  • Off-ramp      │    │
│  │  • Terms & dates │     │  • Bank transfer │     │  • Wallet payout │    │
│  └──────────────────┘     └──────────────────┘     └──────────────────┘    │
│           │                        │                        │               │
│           ▼                        ▼                        ▼               │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  Client Portal   │     │  Payment Monitor │     │  Reconciliation  │    │
│  │                  │     │                  │     │                  │    │
│  │  • View invoice  │     │  • Track status  │     │  • Match payments│    │
│  │  • Select method │     │  • Detect payment│     │  • Sync to books │    │
│  │  • Make payment  │     │  • Send receipts │     │  • Generate reports│  │
│  └──────────────────┘     └──────────────────┘     └──────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Invoice Data Model

The invoice data model captures all information needed for flexible multi-currency invoicing.

```typescript
// Core invoice entity
interface Invoice {
  id: string;
  invoiceNumber: string;           // Human-readable number (e.g., "INV-2026-0042")
  organizationId: string;          // The business sending the invoice
  
  // Client information
  clientId: string;                // Reference to client record
  clientName: string;              // Client's business name
  clientEmail: string;             // Where to send the invoice
  clientAddress?: string;          // Billing address
  
  // Invoice details
  title?: string;                  // Optional invoice title/description
  lineItems: InvoiceLineItem[];    // Itemized charges
  notes?: string;                  // Additional notes for the client
  terms?: string;                  // Payment terms
  
  // Amounts (in invoice currency)
  currency: string;                // Invoice currency (USD, EUR, GBP, etc.)
  subtotal: number;                // Sum of line items before tax
  taxAmount: number;               // Total tax
  discountAmount: number;          // Total discounts
  total: number;                   // Final amount due
  
  // Payment flexibility - what the client can pay with
  acceptedPaymentMethods: PaymentMethod[];
  acceptedCurrencies: string[];    // e.g., ['USD', 'EUR', 'USDC', 'USDT']
  
  // How the business wants to receive funds
  settlementPreference: SettlementPreference;
  
  // Dates
  issueDate: Date;
  dueDate: Date;
  
  // Status tracking
  status: InvoiceStatus;
  sentAt?: Date;
  viewedAt?: Date;
  paidAt?: Date;
  
  // Payment information (populated when paid)
  payment?: InvoicePayment;
  
  // Branding
  logoUrl?: string;
  accentColor?: string;
  
  // Integration
  externalId?: string;             // ID in external accounting system
  syncedToAccounting: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

// Individual line item on an invoice
interface InvoiceLineItem {
  id: string;
  description: string;             // What was provided
  quantity: number;                // Number of units
  unitPrice: number;               // Price per unit
  amount: number;                  // quantity × unitPrice
  taxRate?: number;                // Tax percentage (e.g., 7.5 for VAT)
  taxAmount?: number;              // Calculated tax
}

// Payment methods the client can use
type PaymentMethod = 
  | 'bank_transfer'        // Traditional wire/ACH
  | 'card'                 // Credit/debit card
  | 'usdc'                 // USDC stablecoin
  | 'usdt'                 // USDT stablecoin
  | 'dai'                  // DAI stablecoin
  | 'mobile_money';        // M-Pesa, MTN, etc.

// How the business wants to receive their money
interface SettlementPreference {
  method: 'stablecoin' | 'bank_account' | 'mobile_money';
  currency: string;                // Preferred currency (USDC, KES, NGN, etc.)
  
  // For stablecoin settlement
  walletAddress?: string;
  walletChain?: string;            // 'base', 'ethereum', 'polygon'
  
  // For bank settlement
  bankAccount?: {
    accountNumber: string;
    bankCode: string;
    bankName: string;
    accountName: string;
  };
  
  // For mobile money
  mobileMoneyAccount?: {
    provider: string;              // 'mpesa', 'mtn', 'airtel'
    phoneNumber: string;
  };
}

// Invoice status progression
type InvoiceStatus = 
  | 'draft'           // Being created
  | 'sent'            // Sent to client
  | 'viewed'          // Client opened the invoice
  | 'partially_paid'  // Some payment received
  | 'paid'            // Fully paid
  | 'overdue'         // Past due date, not paid
  | 'cancelled'       // Voided
  | 'refunded';       // Payment returned

// Record of payment received
interface InvoicePayment {
  id: string;
  invoiceId: string;
  
  // What the client paid
  paidAmount: number;
  paidCurrency: string;            // Could differ from invoice currency
  paymentMethod: PaymentMethod;
  
  // Transaction reference
  transactionId?: string;          // Bank reference or card auth
  txHash?: string;                 // Blockchain transaction hash
  
  // What was settled to the business
  settledAmount: number;
  settledCurrency: string;
  settlementTxHash?: string;
  
  // Fees
  processingFee: number;
  exchangeFee?: number;
  
  // Timestamps
  paidAt: Date;
  settledAt: Date;
}
```

---

## Multi-Currency Payment Acceptance

The payment acceptance flow allows clients to pay in their preferred currency while automatically converting and settling to the business's preferred format.

```typescript
// Service handling payment acceptance for invoices
class InvoicePaymentService {
  private paymentProviders: Map<PaymentMethod, PaymentProvider>;
  private exchangeService: ExchangeService;
  private settlementService: SettlementService;
  
  /**
   * Generates payment options for a client viewing an invoice.
   * Shows all available payment methods with current exchange rates.
   */
  async getPaymentOptions(invoiceId: string): Promise<PaymentOptions> {
    const invoice = await this.getInvoice(invoiceId);
    const options: PaymentOption[] = [];
    
    for (const method of invoice.acceptedPaymentMethods) {
      for (const currency of invoice.acceptedCurrencies) {
        // Calculate amount in this currency
        const rate = await this.exchangeService.getRate(
          invoice.currency, 
          currency
        );
        
        const amountInCurrency = invoice.total * rate.rate;
        const fee = this.calculateFee(method, amountInCurrency, currency);
        
        options.push({
          method,
          currency,
          amount: amountInCurrency,
          fee,
          totalWithFee: amountInCurrency + fee,
          exchangeRate: rate.rate,
          expiresAt: rate.expiresAt,  // Rate is valid until this time
          paymentInstructions: await this.getPaymentInstructions(
            method, 
            currency, 
            invoiceId
          )
        });
      }
    }
    
    return {
      invoiceId,
      invoiceTotal: invoice.total,
      invoiceCurrency: invoice.currency,
      options,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000)  // Options valid for 15 min
    };
  }
  
  /**
   * Generates payment instructions for a specific method.
   * For crypto, this creates a unique payment address.
   * For bank transfers, returns account details.
   */
  private async getPaymentInstructions(
    method: PaymentMethod,
    currency: string,
    invoiceId: string
  ): Promise<PaymentInstructions> {
    
    if (method === 'usdc' || method === 'usdt' || method === 'dai') {
      // Generate a unique deposit address for this invoice
      // This allows automatic payment detection and matching
      const depositAddress = await this.walletService.createDepositAddress({
        invoiceId,
        expectedCurrency: currency,
        expectedChain: 'base'  // Default to Base for low fees
      });
      
      return {
        type: 'crypto',
        address: depositAddress.address,
        chain: 'Base',
        chainId: 8453,
        currency,
        memo: invoiceId,  // Include invoice ID for matching
        qrCodeUrl: await this.generateQRCode(depositAddress.address, currency)
      };
    }
    
    if (method === 'bank_transfer') {
      // Return virtual account details for receiving fiat
      const virtualAccount = await this.bankingService.getVirtualAccount(currency);
      
      return {
        type: 'bank_transfer',
        accountNumber: virtualAccount.accountNumber,
        routingNumber: virtualAccount.routingNumber,
        bankName: virtualAccount.bankName,
        accountName: virtualAccount.accountName,
        reference: invoiceId,  // Client should include this reference
        swiftCode: virtualAccount.swiftCode
      };
    }
    
    if (method === 'card') {
      // Return a payment link for card processing
      const paymentLink = await this.cardProcessor.createPaymentLink({
        invoiceId,
        amount: invoice.total,
        currency
      });
      
      return {
        type: 'card',
        paymentUrl: paymentLink.url,
        expiresAt: paymentLink.expiresAt
      };
    }
    
    // Handle other methods...
  }
  
  /**
   * Processes an incoming payment and settles to the business.
   * Handles currency conversion if the payment currency differs
   * from the settlement preference.
   */
  async processPayment(paymentEvent: PaymentEvent): Promise<PaymentResult> {
    const invoice = await this.getInvoice(paymentEvent.invoiceId);
    
    // Verify payment amount matches (with tolerance for exchange fluctuation)
    const expectedAmount = await this.getExpectedAmount(
      invoice, 
      paymentEvent.currency
    );
    
    const tolerance = 0.02;  // 2% tolerance for rate fluctuation
    if (paymentEvent.amount < expectedAmount * (1 - tolerance)) {
      // Partial payment - record but don't mark as paid
      await this.recordPartialPayment(invoice, paymentEvent);
      return { status: 'partial', amountReceived: paymentEvent.amount };
    }
    
    // Full payment received - now settle to the business
    const settlement = await this.settlementService.settle({
      invoiceId: invoice.id,
      organizationId: invoice.organizationId,
      receivedAmount: paymentEvent.amount,
      receivedCurrency: paymentEvent.currency,
      settlementPreference: invoice.settlementPreference
    });
    
    // Update invoice status
    await this.updateInvoiceStatus(invoice.id, 'paid', {
      payment: {
        paidAmount: paymentEvent.amount,
        paidCurrency: paymentEvent.currency,
        paymentMethod: paymentEvent.method,
        txHash: paymentEvent.txHash,
        settledAmount: settlement.amount,
        settledCurrency: settlement.currency,
        settlementTxHash: settlement.txHash,
        paidAt: new Date(),
        settledAt: settlement.settledAt
      }
    });
    
    // Send payment confirmation to client
    await this.sendPaymentConfirmation(invoice, paymentEvent);
    
    // Sync to accounting system
    await this.syncToAccounting(invoice);
    
    return { 
      status: 'completed', 
      settlementAmount: settlement.amount,
      settlementCurrency: settlement.currency
    };
  }
}

// Payment options shown to the client
interface PaymentOptions {
  invoiceId: string;
  invoiceTotal: number;
  invoiceCurrency: string;
  options: PaymentOption[];
  expiresAt: Date;
}

interface PaymentOption {
  method: PaymentMethod;
  currency: string;
  amount: number;                  // Amount to pay in this currency
  fee: number;                     // Processing fee
  totalWithFee: number;
  exchangeRate: number;            // Rate from invoice currency
  expiresAt: Date;                 // When this rate expires
  paymentInstructions: PaymentInstructions;
}
```

---

## Payment Detection and Settlement

The system needs to monitor for incoming payments and automatically match them to invoices.

```typescript
// Service that monitors for incoming crypto payments
class CryptoPaymentMonitor {
  private chainProviders: Map<string, ChainProvider>;
  
  /**
   * Starts monitoring for payments to invoice deposit addresses.
   * Uses websocket subscriptions for real-time detection.
   */
  async startMonitoring(): Promise<void> {
    // Subscribe to Base chain events
    const baseProvider = this.chainProviders.get('base');
    
    // Monitor USDC transfers
    const usdcContract = new Contract(USDC_ADDRESS, ERC20_ABI, baseProvider);
    
    usdcContract.on('Transfer', async (from, to, amount, event) => {
      // Check if this is a payment to one of our deposit addresses
      const depositAddress = await this.getDepositAddressInfo(to);
      
      if (depositAddress) {
        await this.handleIncomingPayment({
          invoiceId: depositAddress.invoiceId,
          currency: 'USDC',
          amount: Number(amount) / 1e6,  // USDC has 6 decimals
          txHash: event.transactionHash,
          from,
          to,
          chain: 'base',
          method: 'usdc'
        });
      }
    });
    
    // Similarly monitor USDT, DAI, etc.
  }
  
  /**
   * Handles an incoming payment detected on-chain.
   */
  private async handleIncomingPayment(payment: IncomingPayment): Promise<void> {
    // Verify the transaction is confirmed
    const confirmations = await this.getConfirmations(payment.txHash, payment.chain);
    
    if (confirmations < REQUIRED_CONFIRMATIONS) {
      // Wait for more confirmations
      await this.scheduleConfirmationCheck(payment);
      return;
    }
    
    // Process the payment
    await this.paymentService.processPayment({
      invoiceId: payment.invoiceId,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      txHash: payment.txHash
    });
  }
}

// Settlement service converts received payments to business's preferred format
class SettlementService {
  private walletService: WalletService;
  private offRampProvider: OffRampProvider;
  private exchangeService: ExchangeService;
  
  /**
   * Settles a payment to the business according to their preference.
   * Handles conversion from payment currency to settlement currency.
   */
  async settle(request: SettlementRequest): Promise<SettlementResult> {
    const preference = request.settlementPreference;
    
    // If payment currency matches settlement preference, direct transfer
    if (request.receivedCurrency === preference.currency && 
        preference.method === 'stablecoin') {
      // Direct stablecoin transfer to business wallet
      const txHash = await this.walletService.transfer({
        to: preference.walletAddress!,
        amount: request.receivedAmount,
        token: request.receivedCurrency,
        chain: preference.walletChain!
      });
      
      return {
        amount: request.receivedAmount,
        currency: request.receivedCurrency,
        txHash,
        settledAt: new Date()
      };
    }
    
    // Need to convert currency
    if (preference.method === 'stablecoin') {
      // Swap to different stablecoin
      const swapResult = await this.exchangeService.swap({
        from: request.receivedCurrency,
        to: preference.currency,
        amount: request.receivedAmount
      });
      
      // Transfer swapped amount to business wallet
      const txHash = await this.walletService.transfer({
        to: preference.walletAddress!,
        amount: swapResult.outputAmount,
        token: preference.currency,
        chain: preference.walletChain!
      });
      
      return {
        amount: swapResult.outputAmount,
        currency: preference.currency,
        txHash,
        settledAt: new Date()
      };
    }
    
    if (preference.method === 'bank_account' || preference.method === 'mobile_money') {
      // Off-ramp to fiat
      const offRampResult = await this.offRampProvider.initiateWithdrawal({
        amount: request.receivedAmount,
        fromCurrency: request.receivedCurrency,
        toCurrency: preference.currency,
        method: preference.method,
        destination: preference.method === 'bank_account' 
          ? preference.bankAccount 
          : preference.mobileMoneyAccount
      });
      
      return {
        amount: offRampResult.outputAmount,
        currency: preference.currency,
        offRampReference: offRampResult.reference,
        settledAt: offRampResult.estimatedArrival  // Off-ramp takes time
      };
    }
  }
}
```

---

## Invoice Management Features

Additional features that make the invoicing system complete and user-friendly.

### Automated Reminders

```typescript
// Service that sends payment reminders for overdue invoices
class InvoiceReminderService {
  
  /**
   * Schedules automatic reminder emails for an invoice.
   * Reminders are sent at configured intervals before and after due date.
   */
  async scheduleReminders(invoice: Invoice): Promise<void> {
    const reminderSchedule = await this.getOrganizationReminderSettings(
      invoice.organizationId
    );
    
    // Schedule pre-due-date reminders
    for (const daysBefore of reminderSchedule.beforeDueDays) {
      const sendAt = new Date(invoice.dueDate);
      sendAt.setDate(sendAt.getDate() - daysBefore);
      
      if (sendAt > new Date()) {  // Only schedule future reminders
        await this.scheduleReminder({
          invoiceId: invoice.id,
          type: 'upcoming_due',
          sendAt
        });
      }
    }
    
    // Schedule post-due-date reminders for overdue invoices
    for (const daysAfter of reminderSchedule.afterDueDays) {
      const sendAt = new Date(invoice.dueDate);
      sendAt.setDate(sendAt.getDate() + daysAfter);
      
      await this.scheduleReminder({
        invoiceId: invoice.id,
        type: 'overdue',
        sendAt
      });
    }
  }
  
  /**
   * Sends a reminder email for an invoice.
   */
  async sendReminder(reminderId: string): Promise<void> {
    const reminder = await this.getReminder(reminderId);
    const invoice = await this.getInvoice(reminder.invoiceId);
    
    // Don't send reminder if invoice is already paid
    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      return;
    }
    
    // Generate payment link with fresh rates
    const paymentLink = await this.generatePaymentLink(invoice.id);
    
    // Send appropriate reminder email
    if (reminder.type === 'upcoming_due') {
      await this.emailService.send({
        to: invoice.clientEmail,
        template: 'invoice_reminder_upcoming',
        data: {
          clientName: invoice.clientName,
          invoiceNumber: invoice.invoiceNumber,
          amount: invoice.total,
          currency: invoice.currency,
          dueDate: invoice.dueDate,
          paymentLink
        }
      });
    } else {
      await this.emailService.send({
        to: invoice.clientEmail,
        template: 'invoice_reminder_overdue',
        data: {
          clientName: invoice.clientName,
          invoiceNumber: invoice.invoiceNumber,
          amount: invoice.total,
          currency: invoice.currency,
          daysOverdue: this.daysSince(invoice.dueDate),
          paymentLink
        }
      });
    }
  }
}
```

### Recurring Invoices

```typescript
// Support for subscription-style recurring invoices
interface RecurringInvoiceConfig {
  id: string;
  organizationId: string;
  clientId: string;
  
  // Template for generating invoices
  template: {
    lineItems: InvoiceLineItem[];
    currency: string;
    notes?: string;
    terms?: string;
  };
  
  // Schedule
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'annually';
  startDate: Date;
  endDate?: Date;                  // Optional end date
  
  // Automation
  autoSend: boolean;               // Automatically send when generated
  daysBefore: number;              // Generate this many days before period end
  
  // Status
  isActive: boolean;
  lastGeneratedAt?: Date;
  nextGenerationDate: Date;
}

class RecurringInvoiceService {
  
  /**
   * Generates the next invoice from a recurring configuration.
   */
  async generateNextInvoice(configId: string): Promise<Invoice> {
    const config = await this.getRecurringConfig(configId);
    const client = await this.getClient(config.clientId);
    
    // Calculate invoice period
    const periodStart = this.calculatePeriodStart(config);
    const periodEnd = this.calculatePeriodEnd(config);
    
    // Create the invoice
    const invoice = await this.invoiceService.create({
      organizationId: config.organizationId,
      clientId: config.clientId,
      clientName: client.name,
      clientEmail: client.email,
      lineItems: config.template.lineItems,
      currency: config.template.currency,
      notes: config.template.notes,
      terms: config.template.terms,
      issueDate: new Date(),
      dueDate: periodEnd,
      recurringConfigId: config.id
    });
    
    // Update config with next generation date
    await this.updateRecurringConfig(config.id, {
      lastGeneratedAt: new Date(),
      nextGenerationDate: this.calculateNextGenerationDate(config)
    });
    
    // Auto-send if configured
    if (config.autoSend) {
      await this.invoiceService.send(invoice.id);
    }
    
    return invoice;
  }
}
```

---

## Invoicing API Design

```
# Invoice CRUD
POST   /api/v1/invoices                    Create new invoice
GET    /api/v1/invoices                    List invoices (with filters)
GET    /api/v1/invoices/:id                Get invoice details
PATCH  /api/v1/invoices/:id                Update invoice
DELETE /api/v1/invoices/:id                Delete draft invoice

# Invoice actions
POST   /api/v1/invoices/:id/send           Send invoice to client
POST   /api/v1/invoices/:id/remind         Send payment reminder
POST   /api/v1/invoices/:id/cancel         Cancel/void invoice
POST   /api/v1/invoices/:id/duplicate      Create copy of invoice

# Client-facing (public, accessed via invoice link)
GET    /api/v1/pay/:invoiceId              Get invoice for payment
GET    /api/v1/pay/:invoiceId/options      Get payment options with rates
POST   /api/v1/pay/:invoiceId/initiate     Initiate payment

# Recurring invoices
POST   /api/v1/recurring-invoices          Create recurring config
GET    /api/v1/recurring-invoices          List recurring configs
PATCH  /api/v1/recurring-invoices/:id      Update recurring config
DELETE /api/v1/recurring-invoices/:id      Delete recurring config

# Clients
POST   /api/v1/clients                     Create client
GET    /api/v1/clients                     List clients
PATCH  /api/v1/clients/:id                 Update client

# Webhooks (for payment notifications)
POST   /api/v1/webhooks/payment            Receive payment notifications
```

---

# Part 3: Payroll System (Deel-Inspired)

This section covers the payroll system, inspired by Deel's global contractor and employee payment platform. The system enables African startups to pay their team members (both contractors and employees) in stablecoins or local currency, with proper documentation and compliance.

---

## Payroll System Overview

The payroll system allows businesses to manage and pay their workforce across multiple African countries. Unlike Deel's full Employer of Record (EOR) model which requires significant legal infrastructure, Expendi Business focuses on the payment and documentation layer, making it easier to implement while still solving the core pain points.

### Core Features

The system provides contractor payments for paying freelancers and contractors with automated invoicing and multi-currency support. It handles employee payroll for processing salary payments with basic tax calculations. The batch payments feature processes multiple payments in a single operation, reducing administrative overhead. Payment flexibility allows workers to receive payment in stablecoins (USDC, USDT), local currency via bank transfer, or mobile money. The system also maintains compliance documentation by generating contracts, payment records, and tax documents.

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            PAYROLL SYSTEM                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  Team Management │     │  Payroll Engine  │     │  Payment         │    │
│  │                  │────▶│                  │────▶│  Processor       │    │
│  │  • Contractors   │     │  • Calculate pay │     │                  │    │
│  │  • Employees     │     │  • Apply taxes   │     │  • Bulk transfer │    │
│  │  • Onboarding    │     │  • Deductions    │     │  • Multi-currency│    │
│  │  • Documents     │     │  • Generate slips│     │  • Off-ramp      │    │
│  └──────────────────┘     └──────────────────┘     └──────────────────┘    │
│           │                        │                        │               │
│           ▼                        ▼                        ▼               │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  Contract        │     │  Compliance      │     │  Reporting       │    │
│  │  Management      │     │  Engine          │     │                  │    │
│  │                  │     │                  │     │  • Pay history   │    │
│  │  • Templates     │     │  • Tax rules     │     │  • Cost analysis │    │
│  │  • E-signatures  │     │  • Document gen  │     │  • Export to     │    │
│  │  • Amendments    │     │  • Country reqs  │     │    accounting    │    │
│  └──────────────────┘     └──────────────────┘     └──────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Contractor Management

Contractor management is the simpler path to start with, as it involves fewer compliance requirements than full employment.

```typescript
// Core contractor entity
interface Contractor {
  id: string;
  organizationId: string;
  
  // Personal information
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  country: string;                 // ISO country code (KE, NG, GH, ZA)
  address?: Address;
  
  // Work information
  role: string;                    // Job title or role description
  department?: string;
  startDate: Date;
  endDate?: Date;                  // For fixed-term contracts
  
  // Compensation
  paymentType: 'hourly' | 'fixed' | 'milestone';
  paymentAmount: number;           // Rate or fixed amount
  paymentCurrency: string;         // Contract currency (USD, EUR, etc.)
  paymentFrequency: 'weekly' | 'biweekly' | 'monthly' | 'milestone';
  
  // Payment preferences
  paymentPreference: PaymentPreference;
  
  // Contract
  contractId?: string;             // Reference to signed contract
  contractStatus: 'pending' | 'signed' | 'expired' | 'terminated';
  
  // Tax information
  taxId?: string;                  // Local tax identification number
  taxDocuments: TaxDocument[];
  
  // Status
  status: 'pending_onboarding' | 'active' | 'paused' | 'terminated';
  
  createdAt: Date;
  updatedAt: Date;
}

// How the contractor wants to be paid
interface PaymentPreference {
  method: 'stablecoin' | 'bank_transfer' | 'mobile_money';
  currency: string;                // Preferred receiving currency
  
  // For stablecoin
  walletAddress?: string;
  walletChain?: string;
  
  // For bank transfer
  bankAccount?: BankAccountDetails;
  
  // For mobile money
  mobileMoneyAccount?: MobileMoneyDetails;
}

interface BankAccountDetails {
  accountNumber: string;
  bankName: string;
  bankCode: string;                // SWIFT or local bank code
  accountHolderName: string;
  country: string;
}

interface MobileMoneyDetails {
  provider: 'mpesa' | 'mtn' | 'airtel' | 'orange';
  phoneNumber: string;
  accountName: string;
}

// Service for managing contractors
class ContractorService {
  
  /**
   * Onboards a new contractor with all required documentation.
   */
  async onboardContractor(request: OnboardContractorRequest): Promise<Contractor> {
    // Create contractor record
    const contractor = await this.createContractor({
      organizationId: request.organizationId,
      firstName: request.firstName,
      lastName: request.lastName,
      email: request.email,
      country: request.country,
      role: request.role,
      paymentType: request.paymentType,
      paymentAmount: request.paymentAmount,
      paymentCurrency: request.paymentCurrency,
      paymentFrequency: request.paymentFrequency,
      status: 'pending_onboarding'
    });
    
    // Generate contract from template
    const contract = await this.contractService.generateContract({
      templateId: request.contractTemplateId || 'standard_contractor',
      contractorId: contractor.id,
      organizationId: request.organizationId,
      variables: {
        contractorName: `${request.firstName} ${request.lastName}`,
        role: request.role,
        paymentAmount: request.paymentAmount,
        paymentCurrency: request.paymentCurrency,
        startDate: request.startDate,
        ...request.customVariables
      }
    });
    
    // Send onboarding email with contract signing link
    await this.emailService.send({
      to: contractor.email,
      template: 'contractor_onboarding',
      data: {
        firstName: contractor.firstName,
        organizationName: request.organizationName,
        role: contractor.role,
        contractSigningLink: contract.signingUrl,
        paymentSetupLink: this.generatePaymentSetupLink(contractor.id)
      }
    });
    
    return contractor;
  }
  
  /**
   * Processes a contractor's payment preference setup.
   */
  async setupPaymentPreference(
    contractorId: string,
    preference: PaymentPreference
  ): Promise<void> {
    // Validate the payment method
    await this.validatePaymentPreference(preference);
    
    // For stablecoin, verify wallet ownership
    if (preference.method === 'stablecoin') {
      // Could implement signature verification here
    }
    
    // For bank account, might want to do a micro-deposit verification
    if (preference.method === 'bank_transfer') {
      // Mark as pending verification
    }
    
    // Update contractor record
    await this.updateContractor(contractorId, {
      paymentPreference: preference
    });
  }
}
```

---

## Employee Payroll

Employee payroll is more complex due to tax withholding and statutory deductions. This implementation focuses on the core African markets: Kenya, Nigeria, Ghana, and South Africa.

```typescript
// Core employee entity (extends basic worker info)
interface Employee {
  id: string;
  organizationId: string;
  
  // Personal information
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  dateOfBirth: Date;
  nationalId: string;              // National ID or passport number
  country: string;
  address: Address;
  
  // Employment information
  employeeNumber?: string;         // Internal employee ID
  role: string;
  department?: string;
  manager?: string;                // Manager's employee ID
  employmentType: 'full_time' | 'part_time';
  startDate: Date;
  probationEndDate?: Date;
  
  // Compensation
  salary: {
    amount: number;
    currency: string;
    frequency: 'monthly' | 'biweekly';
    effectiveDate: Date;
  };
  allowances: Allowance[];         // Housing, transport, etc.
  
  // Tax information
  taxId: string;                   // KRA PIN (Kenya), TIN (Nigeria), etc.
  taxBracket?: string;             // For countries with bracket systems
  
  // Statutory deductions
  socialSecurityId?: string;       // NSSF (Kenya), Pension (Nigeria)
  healthInsuranceId?: string;      // NHIF (Kenya), NHIS (Ghana)
  
  // Payment preferences
  paymentPreference: PaymentPreference;
  
  // Status
  status: 'pending' | 'active' | 'on_leave' | 'terminated';
  
  createdAt: Date;
  updatedAt: Date;
}

// Additional compensation components
interface Allowance {
  type: 'housing' | 'transport' | 'meal' | 'communication' | 'other';
  name: string;
  amount: number;
  taxable: boolean;                // Whether this is subject to income tax
}

// Payroll calculation engine
class PayrollEngine {
  private taxCalculators: Map<string, TaxCalculator>;
  
  constructor() {
    // Register tax calculators for each supported country
    this.taxCalculators.set('KE', new KenyaTaxCalculator());
    this.taxCalculators.set('NG', new NigeriaTaxCalculator());
    this.taxCalculators.set('GH', new GhanaTaxCalculator());
    this.taxCalculators.set('ZA', new SouthAfricaTaxCalculator());
  }
  
  /**
   * Calculates payroll for an employee for a given period.
   * Handles gross pay, deductions, and net pay calculation.
   */
  async calculatePayroll(
    employee: Employee,
    period: PayrollPeriod
  ): Promise<PayrollCalculation> {
    const country = employee.country;
    const taxCalculator = this.taxCalculators.get(country);
    
    if (!taxCalculator) {
      throw new Error(`Tax calculation not supported for country: ${country}`);
    }
    
    // Calculate gross pay
    const baseSalary = this.calculateBaseSalary(employee, period);
    const allowances = this.calculateAllowances(employee, period);
    const grossPay = baseSalary + allowances.total;
    
    // Calculate statutory deductions
    const taxableIncome = grossPay - allowances.nonTaxable;
    const incomeTax = taxCalculator.calculateIncomeTax(taxableIncome, employee);
    const socialSecurity = taxCalculator.calculateSocialSecurity(grossPay, employee);
    const healthInsurance = taxCalculator.calculateHealthInsurance(grossPay, employee);
    
    // Calculate employer contributions (not deducted from employee)
    const employerContributions = taxCalculator.calculateEmployerContributions(
      grossPay, 
      employee
    );
    
    // Other deductions (loans, advances, etc.)
    const otherDeductions = await this.getOtherDeductions(employee.id, period);
    
    // Calculate net pay
    const totalDeductions = incomeTax + socialSecurity + healthInsurance + 
                           otherDeductions.total;
    const netPay = grossPay - totalDeductions;
    
    return {
      employeeId: employee.id,
      period,
      
      // Earnings
      earnings: {
        baseSalary,
        allowances: allowances.breakdown,
        grossPay
      },
      
      // Deductions
      deductions: {
        incomeTax,
        socialSecurity,
        healthInsurance,
        other: otherDeductions.breakdown,
        totalDeductions
      },
      
      // Employer costs (for reporting)
      employerContributions: {
        socialSecurity: employerContributions.socialSecurity,
        other: employerContributions.other,
        total: employerContributions.total
      },
      
      // Final amounts
      netPay,
      totalCostToEmployer: grossPay + employerContributions.total,
      
      // Payment details
      paymentCurrency: employee.salary.currency,
      paymentPreference: employee.paymentPreference
    };
  }
}

// Country-specific tax calculator interface
interface TaxCalculator {
  calculateIncomeTax(taxableIncome: number, employee: Employee): number;
  calculateSocialSecurity(grossPay: number, employee: Employee): number;
  calculateHealthInsurance(grossPay: number, employee: Employee): number;
  calculateEmployerContributions(grossPay: number, employee: Employee): {
    socialSecurity: number;
    other: number;
    total: number;
  };
}

// Kenya-specific tax implementation
class KenyaTaxCalculator implements TaxCalculator {
  // 2024 Kenya PAYE tax bands (in KES)
  private readonly taxBands = [
    { min: 0, max: 24000, rate: 0.10 },
    { min: 24001, max: 32333, rate: 0.25 },
    { min: 32334, max: 500000, rate: 0.30 },
    { min: 500001, max: 800000, rate: 0.325 },
    { min: 800001, max: Infinity, rate: 0.35 }
  ];
  
  // Personal relief (monthly)
  private readonly personalRelief = 2400;
  
  calculateIncomeTax(taxableIncome: number, employee: Employee): number {
    let tax = 0;
    let remainingIncome = taxableIncome;
    
    for (const band of this.taxBands) {
      if (remainingIncome <= 0) break;
      
      const taxableInBand = Math.min(
        remainingIncome, 
        band.max - band.min + 1
      );
      tax += taxableInBand * band.rate;
      remainingIncome -= taxableInBand;
    }
    
    // Apply personal relief
    tax = Math.max(0, tax - this.personalRelief);
    
    return tax;
  }
  
  calculateSocialSecurity(grossPay: number, employee: Employee): number {
    // NSSF Tier I and II contributions
    const tier1Limit = 7000;       // Lower earnings limit
    const tier2Limit = 36000;      // Upper earnings limit
    const rate = 0.06;             // 6% employee contribution
    
    const pensionableEarnings = Math.min(grossPay, tier2Limit);
    return pensionableEarnings * rate;
  }
  
  calculateHealthInsurance(grossPay: number, employee: Employee): number {
    // NHIF rates based on gross pay (simplified)
    if (grossPay <= 5999) return 150;
    if (grossPay <= 7999) return 300;
    if (grossPay <= 11999) return 400;
    if (grossPay <= 14999) return 500;
    if (grossPay <= 19999) return 600;
    if (grossPay <= 24999) return 750;
    if (grossPay <= 29999) return 850;
    if (grossPay <= 34999) return 900;
    if (grossPay <= 39999) return 950;
    if (grossPay <= 44999) return 1000;
    if (grossPay <= 49999) return 1100;
    if (grossPay <= 59999) return 1200;
    if (grossPay <= 69999) return 1300;
    if (grossPay <= 79999) return 1400;
    if (grossPay <= 89999) return 1500;
    if (grossPay <= 99999) return 1600;
    return 1700;                   // 100,000 and above
  }
  
  calculateEmployerContributions(grossPay: number, employee: Employee): {
    socialSecurity: number;
    other: number;
    total: number;
  } {
    // Employer NSSF contribution matches employee
    const nssf = this.calculateSocialSecurity(grossPay, employee);
    
    return {
      socialSecurity: nssf,
      other: 0,
      total: nssf
    };
  }
}
```

---

## Payroll Data Model

Complete data model for running payroll operations.

```typescript
// A payroll run groups all payments for a period
interface PayrollRun {
  id: string;
  organizationId: string;
  
  // Period
  period: PayrollPeriod;
  
  // Status
  status: PayrollRunStatus;
  
  // Calculations
  calculations: PayrollCalculation[];
  
  // Totals
  summary: {
    totalEmployees: number;
    totalContractors: number;
    totalGrossPay: number;
    totalDeductions: number;
    totalNetPay: number;
    totalEmployerCosts: number;
    byCurrency: Map<string, CurrencySummary>;
  };
  
  // Payment execution
  paymentBatchId?: string;
  paidAt?: Date;
  
  // Audit
  createdBy: string;
  approvedBy?: string;
  approvedAt?: Date;
  
  createdAt: Date;
  updatedAt: Date;
}

interface PayrollPeriod {
  startDate: Date;
  endDate: Date;
  payDate: Date;                   // When payments will be made
}

type PayrollRunStatus = 
  | 'draft'           // Being prepared
  | 'pending_approval'// Waiting for approval
  | 'approved'        // Ready to process
  | 'processing'      // Payments being sent
  | 'completed'       // All payments sent
  | 'failed';         // Some payments failed

// Result of payroll calculation for one worker
interface PayrollCalculation {
  id: string;
  payrollRunId: string;
  
  // Worker reference
  workerId: string;
  workerType: 'employee' | 'contractor';
  workerName: string;
  
  // Earnings breakdown
  earnings: {
    baseSalary: number;
    allowances: AllowanceBreakdown[];
    bonuses?: number;
    overtime?: number;
    grossPay: number;
  };
  
  // Deductions breakdown
  deductions: {
    incomeTax: number;
    socialSecurity: number;
    healthInsurance: number;
    other: DeductionBreakdown[];
    totalDeductions: number;
  };
  
  // Employer costs
  employerContributions: {
    socialSecurity: number;
    other: number;
    total: number;
  };
  
  // Net pay
  netPay: number;
  paymentCurrency: string;
  
  // Payment execution
  paymentStatus: 'pending' | 'processing' | 'completed' | 'failed';
  paymentMethod: PaymentMethod;
  paymentTxHash?: string;
  paymentError?: string;
  paidAt?: Date;
}

// Payslip generated from calculation
interface Payslip {
  id: string;
  calculationId: string;
  workerId: string;
  
  // Content (rendered PDF or structured data)
  pdfUrl: string;
  
  // Period
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  
  // Summary amounts
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  currency: string;
  
  // Delivery
  sentAt?: Date;
  viewedAt?: Date;
  
  createdAt: Date;
}
```

---

## Compliance and Tax Handling

Managing compliance documentation and tax reporting for multiple countries.

```typescript
// Contract template management
interface ContractTemplate {
  id: string;
  organizationId?: string;         // null for system templates
  
  name: string;
  description: string;
  country: string;                 // Country this template is valid for
  workerType: 'contractor' | 'employee';
  
  // Template content with variable placeholders
  content: string;                 // HTML or Markdown with {{variables}}
  variables: TemplateVariable[];
  
  // Legal
  lastLegalReview: Date;
  isCompliant: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

interface TemplateVariable {
  name: string;                    // e.g., "contractorName"
  label: string;                   // e.g., "Contractor's Full Name"
  type: 'text' | 'date' | 'number' | 'currency';
  required: boolean;
  defaultValue?: string;
}

// Tax document management
interface TaxDocument {
  id: string;
  workerId: string;
  workerType: 'employee' | 'contractor';
  
  // Document type
  type: TaxDocumentType;
  country: string;
  
  // Period
  taxYear: number;
  periodStart?: Date;
  periodEnd?: Date;
  
  // Content
  pdfUrl: string;
  data: Record<string, any>;       // Structured data used to generate doc
  
  // Status
  status: 'draft' | 'generated' | 'filed' | 'amended';
  filedAt?: Date;
  
  createdAt: Date;
}

type TaxDocumentType = 
  // Kenya
  | 'P9A'              // Annual PAYE tax deduction card
  | 'P10'              // Monthly PAYE return
  
  // Nigeria
  | 'Annual_Tax_Return'
  | 'Monthly_PAYE'
  
  // South Africa
  | 'IRP5'             // Employee tax certificate
  | 'IT3a'             // Annuities/lump sum certificate
  
  // Generic
  | 'Payment_Summary'
  | 'Contractor_Statement';

// Service for generating compliance documents
class ComplianceDocumentService {
  
  /**
   * Generates year-end tax documents for all employees.
   */
  async generateYearEndDocuments(
    organizationId: string,
    taxYear: number
  ): Promise<TaxDocument[]> {
    const employees = await this.getEmployees(organizationId);
    const documents: TaxDocument[] = [];
    
    for (const employee of employees) {
      // Get all payroll calculations for the year
      const calculations = await this.getYearCalculations(
        employee.id, 
        taxYear
      );
      
      // Generate country-specific document
      const docType = this.getYearEndDocType(employee.country);
      
      const doc = await this.generateDocument({
        type: docType,
        workerId: employee.id,
        workerType: 'employee',
        country: employee.country,
        taxYear,
        data: this.aggregateYearData(calculations)
      });
      
      documents.push(doc);
    }
    
    return documents;
  }
  
  /**
   * Generates a P9A form for a Kenyan employee.
   */
  private async generateKenyaP9A(
    employee: Employee,
    calculations: PayrollCalculation[]
  ): Promise<TaxDocument> {
    // Aggregate annual figures
    const annualData = {
      employeeName: `${employee.firstName} ${employee.lastName}`,
      employerName: await this.getOrganizationName(employee.organizationId),
      employerPin: await this.getOrganizationTaxId(employee.organizationId),
      employeePin: employee.taxId,
      
      // Monthly breakdown
      months: calculations.map(calc => ({
        month: this.getMonthName(calc.period),
        grossPay: calc.earnings.grossPay,
        benefits: calc.earnings.allowances.reduce((sum, a) => sum + a.amount, 0),
        pension: calc.deductions.socialSecurity,
        taxCharged: calc.deductions.incomeTax
      })),
      
      // Annual totals
      totalGrossPay: this.sum(calculations, c => c.earnings.grossPay),
      totalBenefits: this.sum(calculations, c => 
        c.earnings.allowances.reduce((sum, a) => sum + a.amount, 0)
      ),
      totalPension: this.sum(calculations, c => c.deductions.socialSecurity),
      totalTax: this.sum(calculations, c => c.deductions.incomeTax)
    };
    
    // Generate PDF using template
    const pdfUrl = await this.pdfGenerator.generate('KE_P9A', annualData);
    
    return this.createTaxDocument({
      type: 'P9A',
      workerId: employee.id,
      workerType: 'employee',
      country: 'KE',
      taxYear: calculations[0].period.startDate.getFullYear(),
      pdfUrl,
      data: annualData,
      status: 'generated'
    });
  }
}
```

---

## Bulk Payment Processing

Processing multiple payments efficiently in a single batch.

```typescript
// Service for executing bulk payments
class BulkPaymentService {
  private walletService: WalletService;
  private offRampProviders: Map<string, OffRampProvider>;
  
  /**
   * Executes all payments for a payroll run.
   * Groups payments by method for efficiency.
   */
  async executePayrollPayments(payrollRunId: string): Promise<PaymentBatchResult> {
    const payrollRun = await this.getPayrollRun(payrollRunId);
    
    // Verify payroll is approved
    if (payrollRun.status !== 'approved') {
      throw new Error('Payroll run must be approved before processing');
    }
    
    // Update status
    await this.updatePayrollRunStatus(payrollRunId, 'processing');
    
    // Group calculations by payment method
    const byMethod = this.groupByPaymentMethod(payrollRun.calculations);
    
    const results: PaymentResult[] = [];
    
    // Process stablecoin payments in batch
    if (byMethod.stablecoin.length > 0) {
      const stablecoinResults = await this.processBatchStablecoinPayments(
        byMethod.stablecoin
      );
      results.push(...stablecoinResults);
    }
    
    // Process bank transfers
    if (byMethod.bank_transfer.length > 0) {
      const bankResults = await this.processBatchBankTransfers(
        byMethod.bank_transfer
      );
      results.push(...bankResults);
    }
    
    // Process mobile money
    if (byMethod.mobile_money.length > 0) {
      const mobileResults = await this.processBatchMobileMoneyPayments(
        byMethod.mobile_money
      );
      results.push(...mobileResults);
    }
    
    // Update payroll run with results
    const allSuccessful = results.every(r => r.status === 'completed');
    await this.updatePayrollRunStatus(
      payrollRunId, 
      allSuccessful ? 'completed' : 'failed'
    );
    
    // Update individual calculation statuses
    for (const result of results) {
      await this.updateCalculationPaymentStatus(
        result.calculationId,
        result.status,
        result.txHash,
        result.error
      );
    }
    
    return {
      payrollRunId,
      totalPayments: results.length,
      successful: results.filter(r => r.status === 'completed').length,
      failed: results.filter(r => r.status === 'failed').length,
      results
    };
  }
  
  /**
   * Processes multiple stablecoin payments in a single transaction.
   * Uses a batch transfer contract for gas efficiency.
   */
  private async processBatchStablecoinPayments(
    calculations: PayrollCalculation[]
  ): Promise<PaymentResult[]> {
    // Group by token (USDC, USDT, etc.)
    const byToken = this.groupByToken(calculations);
    const results: PaymentResult[] = [];
    
    for (const [token, tokenCalcs] of Object.entries(byToken)) {
      // Prepare batch transfer
      const transfers = tokenCalcs.map(calc => ({
        to: calc.paymentPreference.walletAddress,
        amount: this.toTokenUnits(calc.netPay, token)
      }));
      
      try {
        // Execute batch transfer
        const txHash = await this.walletService.batchTransfer({
          token,
          chain: 'base',
          transfers
        });
        
        // Mark all as successful
        for (const calc of tokenCalcs) {
          results.push({
            calculationId: calc.id,
            status: 'completed',
            txHash,
            amount: calc.netPay,
            currency: token
          });
        }
      } catch (error) {
        // If batch fails, try individual transfers
        for (const calc of tokenCalcs) {
          try {
            const txHash = await this.walletService.transfer({
              to: calc.paymentPreference.walletAddress,
              amount: this.toTokenUnits(calc.netPay, token),
              token,
              chain: 'base'
            });
            
            results.push({
              calculationId: calc.id,
              status: 'completed',
              txHash,
              amount: calc.netPay,
              currency: token
            });
          } catch (individualError) {
            results.push({
              calculationId: calc.id,
              status: 'failed',
              error: individualError.message,
              amount: calc.netPay,
              currency: token
            });
          }
        }
      }
    }
    
    return results;
  }
  
  /**
   * Processes bank transfers through the appropriate off-ramp provider.
   */
  private async processBatchBankTransfers(
    calculations: PayrollCalculation[]
  ): Promise<PaymentResult[]> {
    // Group by country (different providers per country)
    const byCountry = this.groupByCountry(calculations);
    const results: PaymentResult[] = [];
    
    for (const [country, countryCalcs] of Object.entries(byCountry)) {
      const provider = this.offRampProviders.get(country);
      
      if (!provider) {
        // Mark all as failed if no provider
        for (const calc of countryCalcs) {
          results.push({
            calculationId: calc.id,
            status: 'failed',
            error: `No off-ramp provider configured for ${country}`,
            amount: calc.netPay,
            currency: calc.paymentCurrency
          });
        }
        continue;
      }
      
      // Process through provider
      const batchResult = await provider.processBatch(
        countryCalcs.map(calc => ({
          amount: calc.netPay,
          currency: calc.paymentCurrency,
          recipient: calc.paymentPreference.bankAccount,
          reference: `PAY-${calc.id}`
        }))
      );
      
      // Map results back to calculations
      for (const calc of countryCalcs) {
        const paymentResult = batchResult.find(r => r.reference === `PAY-${calc.id}`);
        
        results.push({
          calculationId: calc.id,
          status: paymentResult?.status === 'success' ? 'completed' : 'failed',
          offRampReference: paymentResult?.transactionId,
          error: paymentResult?.error,
          amount: calc.netPay,
          currency: calc.paymentCurrency
        });
      }
    }
    
    return results;
  }
}

// Result types
interface PaymentBatchResult {
  payrollRunId: string;
  totalPayments: number;
  successful: number;
  failed: number;
  results: PaymentResult[];
}

interface PaymentResult {
  calculationId: string;
  status: 'completed' | 'failed';
  txHash?: string;                 // For crypto payments
  offRampReference?: string;       // For fiat payments
  error?: string;
  amount: number;
  currency: string;
}
```

---

## Payroll API Design

```
# Team management
POST   /api/v1/contractors                 Add contractor
GET    /api/v1/contractors                 List contractors
GET    /api/v1/contractors/:id             Get contractor details
PATCH  /api/v1/contractors/:id             Update contractor
DELETE /api/v1/contractors/:id             Remove contractor

POST   /api/v1/employees                   Add employee
GET    /api/v1/employees                   List employees
GET    /api/v1/employees/:id               Get employee details
PATCH  /api/v1/employees/:id               Update employee
DELETE /api/v1/employees/:id               Terminate employee

# Onboarding
POST   /api/v1/onboarding/contractor       Start contractor onboarding
POST   /api/v1/onboarding/employee         Start employee onboarding
POST   /api/v1/onboarding/:id/payment-setup Set up payment preferences

# Contracts
GET    /api/v1/contracts/templates         List contract templates
POST   /api/v1/contracts                   Generate contract
GET    /api/v1/contracts/:id               Get contract
POST   /api/v1/contracts/:id/sign          Sign contract

# Payroll runs
POST   /api/v1/payroll/runs                Create payroll run
GET    /api/v1/payroll/runs                List payroll runs
GET    /api/v1/payroll/runs/:id            Get payroll run details
POST   /api/v1/payroll/runs/:id/calculate  Calculate payroll
POST   /api/v1/payroll/runs/:id/approve    Approve payroll
POST   /api/v1/payroll/runs/:id/execute    Execute payments

# Payslips
GET    /api/v1/payslips                    List payslips
GET    /api/v1/payslips/:id                Get payslip
GET    /api/v1/payslips/:id/pdf            Download payslip PDF

# Tax documents
GET    /api/v1/tax-documents               List tax documents
POST   /api/v1/tax-documents/generate      Generate tax documents
GET    /api/v1/tax-documents/:id           Get tax document
GET    /api/v1/tax-documents/:id/pdf       Download document PDF

# Reporting
GET    /api/v1/payroll/reports/summary     Get payroll summary
GET    /api/v1/payroll/reports/by-country  Get breakdown by country
GET    /api/v1/payroll/reports/costs       Get employer costs report
```

---

## Kenya eTIMS Tax Integration

Since Expendi Business is piloting in Kenya, compliance with the Kenya Revenue Authority (KRA) electronic Tax Invoice Management System (eTIMS) is mandatory. All businesses in Kenya must issue electronic tax invoices for any sale or transaction.

### What is eTIMS?

eTIMS (electronic Tax Invoice Management System) is KRA's e-invoicing system that became effective on January 1, 2024. Key requirements include all persons engaged in business must onboard eTIMS and issue electronic tax invoices, for any business expense to be claimed, it must be supported by an electronic tax invoice, and both VAT and non-VAT taxpayers must comply.

### Integration Approach

Rather than building direct integration with KRA's eTIMS system (which requires significant technical resources and KRA certification), Expendi Business will integrate via DigiTax, a KRA-approved OSCU (Online Sales Control Unit) integrator. This approach reduces development time by approximately 70%, handles KRA certification and compliance automatically, provides callback URLs for real-time invoice status updates, and works across Kenya, Nigeria, and Zambia for future expansion.

### DigiTax Integration Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        eTIMS INTEGRATION FLOW                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  Expendi Invoice │     │  DigiTax API     │     │  KRA eTIMS       │    │
│  │  Service         │────▶│  (OSCU Provider) │────▶│  System          │    │
│  │                  │     │                  │     │                  │    │
│  │  • Create invoice│     │  • Sign invoice  │     │  • Validate      │    │
│  │  • Add items     │     │  • Generate QR   │     │  • Store         │    │
│  │  • Submit to KRA │     │  • Track status  │     │  • Issue receipt │    │
│  └──────────────────┘     └──────────────────┘     └──────────────────┘    │
│           │                        │                        │               │
│           │                        ▼                        │               │
│           │               ┌──────────────────┐              │               │
│           └──────────────▶│  Callback/       │◀─────────────┘               │
│                           │  Webhook Handler │                              │
│                           │                  │                              │
│                           │  • Status update │                              │
│                           │  • QR code/sig   │                              │
│                           │  • Error handling│                              │
│                           └──────────────────┘                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### eTIMS Data Model Extensions

The invoice and item models need additional fields for eTIMS compliance.

```typescript
// eTIMS-specific fields for invoices
interface ETIMSInvoiceFields {
  // KRA-assigned identifiers
  kraReceiptNumber?: string;       // Receipt number from KRA
  kraSCUId?: string;               // Sales Control Unit ID
  kraSignature?: string;           // Digital signature from KRA
  kraInternalData?: string;        // Internal data string
  
  // QR code for verification
  etimsQRCodeUrl?: string;         // QR code image URL
  etimsVerificationUrl?: string;   // URL for verifying invoice on KRA portal
  
  // Receipt type
  receiptTypeCode: 'S' | 'R';      // S = Sale, R = Credit Note
  
  // For credit notes - reference to original invoice
  originalInvoiceNumber?: string;
  
  // Invoice status per KRA
  etimsStatus: ETIMSInvoiceStatus;
  
  // Submission tracking
  submittedToETIMS: boolean;
  etimsSubmittedAt?: Date;
  etimsResponseAt?: Date;
  etimsError?: string;
}

type ETIMSInvoiceStatus = 
  | 'pending'              // Not yet submitted
  | 'submitted'            // Sent to DigiTax/KRA
  | 'wait_for_approval'    // KRA processing
  | 'approved'             // Accepted by KRA
  | 'cancel_requested'     // Cancellation requested
  | 'canceled'             // Cancelled
  | 'credit_note_generated'; // Credit note issued

// eTIMS-specific fields for invoice line items
interface ETIMSItemFields {
  // KRA item registration
  kraItemCode?: string;            // Item code from KRA
  
  // Item classification (required by KRA)
  itemClassCode: string;           // e.g., "5059690800" - see KRA classification table
  itemTypeCode: '1' | '2' | '3';   // 1=Raw Material, 2=Finished Product, 3=Service
  
  // Origin and packaging
  originNationCode: string;        // ISO country code, e.g., "KE"
  packageUnitCode: string;         // e.g., "NT" for Net, "BA" for Barrel
  quantityUnitCode: string;        // e.g., "KG", "U" for pieces
  
  // Taxation
  taxTypeCode: TaxTypeCode;        // VAT classification
}

// Kenya VAT tax types
type TaxTypeCode = 
  | 'A'   // Exempt
  | 'B'   // 16% VAT (standard rate)
  | 'C'   // 0% VAT (zero-rated)
  | 'D'   // Non-VAT
  | 'E';  // 8% VAT (reduced rate)

// Payment type codes for eTIMS
type ETIMSPaymentTypeCode = 
  | '01'  // Cash
  | '02'  // Credit
  | '03'  // Cash/Credit
  | '04'  // Bank Check
  | '05'  // Debit & Credit Card
  | '06'  // Mobile Money
  | '07'; // Other
```

### DigiTax API Integration Service

```typescript
// Service for integrating with DigiTax Kenya API
class DigiTaxService {
  private apiKey: string;
  private baseUrl: string = 'https://api.digitax.tech/v2';
  
  constructor(config: DigiTaxConfig) {
    this.apiKey = config.apiKey;
    if (config.sandbox) {
      this.baseUrl = 'https://sandbox.api.digitax.tech/v2';
    }
  }
  
  /**
   * Registers an item with KRA eTIMS.
   * Items must be registered before they can be included in invoices.
   */
  async registerItem(item: ETIMSItem): Promise<RegisterItemResult> {
    const response = await this.makeRequest('POST', '/items', {
      active: true,
      item_class_code: item.itemClassCode,
      item_type_code: item.itemTypeCode,
      item_name: item.name,
      origin_nation_code: item.originNationCode,
      package_unit_code: item.packageUnitCode,
      quantity_unit_code: item.quantityUnitCode,
      tax_type_code: item.taxTypeCode,
      default_unit_price: item.defaultUnitPrice
    });
    
    return {
      itemId: response.id,
      kraItemCode: response.item_code,
      status: response.queue_status
    };
  }
  
  /**
   * Submits a sale invoice to KRA via DigiTax.
   * Returns immediately with a queue status; use callback URL for final status.
   */
  async submitSale(invoice: Invoice, items: InvoiceLineItem[]): Promise<SubmitSaleResult> {
    // Map items to DigiTax format
    const digitaxItems = items.map(item => ({
      item_id: item.kraItemCode,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      discount: item.discount || 0,
      tax_type_code: item.taxTypeCode
    }));
    
    const response = await this.makeRequest('POST', '/sales', {
      trader_invoice_number: invoice.invoiceNumber,
      invoice_number: this.extractNumericInvoiceNumber(invoice.invoiceNumber),
      receipt_type_code: 'S',  // Sale
      payment_type_code: this.mapPaymentType(invoice.paymentMethod),
      invoice_status_code: '02',  // Approved
      items: digitaxItems
    });
    
    return {
      saleId: response.id,
      queueStatus: response.queue_status,
      traderInvoiceNumber: response.trader_invoice_number
    };
  }
  
  /**
   * Submits a credit note to reverse a previous sale.
   */
  async submitCreditNote(
    creditNote: Invoice, 
    originalInvoiceNumber: string,
    items: InvoiceLineItem[]
  ): Promise<SubmitSaleResult> {
    const digitaxItems = items.map(item => ({
      item_id: item.kraItemCode,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      tax_type_code: item.taxTypeCode
    }));
    
    const response = await this.makeRequest('POST', '/sales', {
      trader_invoice_number: creditNote.invoiceNumber,
      invoice_number: this.extractNumericInvoiceNumber(creditNote.invoiceNumber),
      receipt_type_code: 'R',  // Credit Note
      original_invoice_number: originalInvoiceNumber,
      payment_type_code: this.mapPaymentType(creditNote.paymentMethod),
      invoice_status_code: '02',
      items: digitaxItems
    });
    
    return {
      saleId: response.id,
      queueStatus: response.queue_status
    };
  }
  
  /**
   * Retrieves the status and KRA response for a submitted sale.
   */
  async getSaleStatus(saleId: string): Promise<SaleStatus> {
    const response = await this.makeRequest('GET', `/sales/${saleId}`);
    
    return {
      saleId: response.id,
      queueStatus: response.queue_status,
      
      // KRA response fields (populated when queue_status is 'complete')
      receiptNumber: response.receipt_number,
      serialNumber: response.serial_number,
      receiptSignature: response.receipt_signature,
      internalData: response.internal_data,
      receiptUrl: response.receipt_url,  // QR code URL
      
      // Tax breakdown
      taxSummary: response.sales_tax_summary
    };
  }
  
  /**
   * Maps Expendi payment methods to eTIMS payment type codes.
   */
  private mapPaymentType(method: PaymentMethod): ETIMSPaymentTypeCode {
    const mapping: Record<PaymentMethod, ETIMSPaymentTypeCode> = {
      'bank_transfer': '04',   // Bank Check (closest match)
      'card': '05',            // Debit & Credit Card
      'usdc': '07',            // Other (crypto)
      'usdt': '07',            // Other (crypto)
      'dai': '07',             // Other (crypto)
      'mobile_money': '06'     // Mobile Money
    };
    return mapping[method] || '07';
  }
  
  /**
   * Makes authenticated request to DigiTax API.
   */
  private async makeRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    body?: Record<string, any>
  ): Promise<any> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey
      },
      body: body ? JSON.stringify(body) : undefined
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new DigiTaxError(error.message, error.code);
    }
    
    return response.json();
  }
}

// Callback handler for DigiTax status updates
class DigiTaxCallbackHandler {
  
  /**
   * Handles callback from DigiTax when invoice status changes.
   * Configure this URL in DigiTax Dashboard under callback settings.
   */
  async handleCallback(payload: DigiTaxCallback): Promise<void> {
    const { sale_id, queue_status, receipt_url, receipt_signature } = payload;
    
    // Find the invoice by DigiTax sale ID
    const invoice = await this.findInvoiceBySaleId(sale_id);
    
    if (queue_status === 'complete') {
      // Update invoice with KRA data
      await this.updateInvoice(invoice.id, {
        etimsStatus: 'approved',
        kraReceiptNumber: payload.receipt_number,
        kraSignature: receipt_signature,
        etimsQRCodeUrl: receipt_url,
        etimsVerificationUrl: this.buildVerificationUrl(payload),
        etimsResponseAt: new Date()
      });
      
      // Notify relevant parties
      await this.notifyInvoiceApproved(invoice);
      
    } else if (queue_status === 'failed') {
      // Handle failure
      await this.updateInvoice(invoice.id, {
        etimsStatus: 'pending',
        etimsError: payload.error_message
      });
      
      // Alert for manual review
      await this.alertETIMSFailure(invoice, payload.error_message);
    }
  }
  
  /**
   * Builds the KRA verification URL from receipt data.
   */
  private buildVerificationUrl(payload: DigiTaxCallback): string {
    return `https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=${payload.kra_pin}${payload.branch_id}${payload.receipt_signature}`;
  }
}
```

### Item Classification for eTIMS

KRA requires all items to be classified according to their HS (Harmonized System) codes. Common classifications for a B2B expense/invoicing platform include:

```typescript
// Common item classifications for Expendi Business services
const COMMON_ITEM_CLASSIFICATIONS = {
  // Software and SaaS services
  SOFTWARE_SERVICES: '8523410000',     // Software on physical media
  CLOUD_SERVICES: '8471500000',        // Processing units
  
  // Professional services
  CONSULTING_SERVICES: '9983110000',   // Management consulting
  ACCOUNTING_SERVICES: '9983190000',   // Accounting services
  LEGAL_SERVICES: '9983110000',        // Legal services
  
  // Financial services
  PAYMENT_PROCESSING: '9984110000',    // Financial services
  TRANSACTION_FEES: '9984110000',      // Financial transaction fees
  
  // General business
  OFFICE_SUPPLIES: '4817100000',       // Envelopes
  PRINTING: '4911100000',              // Printed advertising
  
  // Subscription/SaaS (map to software)
  SUBSCRIPTION_FEE: '8523410000'
};

// Helper to determine item classification
function getItemClassification(item: InvoiceLineItem): string {
  // For Expendi Business, most items will be services
  if (item.type === 'subscription') {
    return COMMON_ITEM_CLASSIFICATIONS.SUBSCRIPTION_FEE;
  }
  
  if (item.type === 'transaction_fee') {
    return COMMON_ITEM_CLASSIFICATIONS.TRANSACTION_FEES;
  }
  
  // Default to consulting services for professional services
  return COMMON_ITEM_CLASSIFICATIONS.CONSULTING_SERVICES;
}
```

### eTIMS Workflow Integration

The eTIMS integration hooks into the existing invoice workflow:

```typescript
// Extended invoice service with eTIMS integration
class InvoiceServiceWithETIMS extends InvoiceService {
  private digitax: DigiTaxService;
  
  /**
   * Override send to also submit to eTIMS.
   */
  async send(invoiceId: string): Promise<void> {
    const invoice = await this.getInvoice(invoiceId);
    
    // First, ensure all items are registered with KRA
    for (const item of invoice.lineItems) {
      if (!item.kraItemCode) {
        const registration = await this.digitax.registerItem({
          name: item.description,
          itemClassCode: getItemClassification(item),
          itemTypeCode: '3',  // Service
          originNationCode: 'KE',
          packageUnitCode: 'NT',
          quantityUnitCode: 'U',
          taxTypeCode: this.determineTaxType(item),
          defaultUnitPrice: item.unitPrice
        });
        
        // Save KRA item code
        await this.updateLineItem(item.id, {
          kraItemCode: registration.kraItemCode
        });
      }
    }
    
    // Submit to eTIMS
    const etimsResult = await this.digitax.submitSale(invoice, invoice.lineItems);
    
    // Update invoice with submission status
    await this.updateInvoice(invoiceId, {
      submittedToETIMS: true,
      etimsSubmittedAt: new Date(),
      digitaxSaleId: etimsResult.saleId,
      etimsStatus: 'submitted'
    });
    
    // Continue with normal send flow
    await super.send(invoiceId);
  }
  
  /**
   * Determines the tax type code based on item and customer.
   */
  private determineTaxType(item: InvoiceLineItem): TaxTypeCode {
    // Export services are zero-rated
    if (item.isExport) return 'C';
    
    // Financial services are exempt
    if (item.category === 'financial_services') return 'A';
    
    // Standard VAT rate for most services
    return 'B';  // 16% VAT
  }
}
```

### eTIMS API Endpoints

```
# eTIMS-specific endpoints for Expendi Business

# Item registration
POST   /api/v1/etims/items                    Register item with KRA
GET    /api/v1/etims/items                    List registered items
GET    /api/v1/etims/items/:kraCode           Get item by KRA code

# Invoice eTIMS status
GET    /api/v1/invoices/:id/etims             Get eTIMS status for invoice
POST   /api/v1/invoices/:id/etims/retry       Retry failed eTIMS submission
GET    /api/v1/invoices/:id/etims/qr          Get QR code image

# Callbacks (called by DigiTax)
POST   /api/v1/webhooks/digitax/callback      eTIMS status callback
POST   /api/v1/webhooks/digitax/offline       Offline receipt callback

# Reporting
GET    /api/v1/etims/reports/daily            Daily eTIMS submission report
GET    /api/v1/etims/reports/failures         Failed submissions report
```

### Implementation Checklist for Kenya Pilot

Before launching in Kenya, ensure:

1. **DigiTax Account Setup**
   - Register on DigiTax Dashboard
   - Complete KRA eTIMS onboarding through DigiTax
   - Obtain sandbox API key for testing
   - Configure callback URLs
   - Complete commercial agreement for production access

2. **Item Registration**
   - Identify all item types that will appear on invoices
   - Map to appropriate KRA item classification codes
   - Register items in sandbox environment
   - Test item creation flow

3. **Invoice Flow Testing**
   - Test sale submission in sandbox
   - Verify QR code generation
   - Test credit note flow
   - Verify callback handling

4. **Production Readiness**
   - Obtain production API key
   - Configure production callback URLs
   - Test end-to-end flow with real KRA validation
   - Monitor for any submission failures

5. **Ongoing Compliance**
   - Monitor KRA regulatory updates
   - Ensure all invoices are submitted within 48 hours
   - Maintain audit trail of all eTIMS submissions
   - Handle offline scenarios gracefully

---

# Part 4: Implementation

## Unified Platform Architecture

All three product areas (expense management, invoicing, payroll) share common infrastructure for identity, payments, and integrations.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        EXPENDI BUSINESS PLATFORM                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Expense   │  │  Invoicing  │  │   Payroll   │  │   Future    │        │
│  │  Management │  │             │  │             │  │  Products   │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│         └────────────────┴────────────────┴────────────────┘               │
│                                   │                                         │
│                                   ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      SHARED SERVICES LAYER                           │   │
│  │                                                                       │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐     │   │
│  │  │ Identity & │  │  Wallet &  │  │ Off-Ramp & │  │Integration │     │   │
│  │  │   Orgs     │  │  Payments  │  │  On-Ramp   │  │   Hub      │     │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────┘     │   │
│  │                                                                       │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐     │   │
│  │  │Notification│  │  Document  │  │  Analytics │  │   Audit    │     │   │
│  │  │  Service   │  │  Storage   │  │  & Reports │  │    Log     │     │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────┘     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                   │                                         │
│                                   ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      INFRASTRUCTURE LAYER                            │   │
│  │                                                                       │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐     │   │
│  │  │ PostgreSQL │  │   Redis    │  │    S3/     │  │ Blockchain │     │   │
│  │  │  Database  │  │   Cache    │  │ Storage    │  │   Nodes    │     │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────┘     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Roadmap

The complete platform should be built in phases, starting with the core expense management and expanding to invoicing and payroll.

### Phase 1: Foundation (Weeks 1-4)

Build the shared infrastructure that all products will use. This includes the organization and user management system, authentication with role-based access control, the wallet service for stablecoin operations on Base, basic off-ramp integration with Yellow Card or Kotani Pay, and document storage using S3-compatible storage.

**Deliverables:** Users can create organizations, invite team members, and connect wallets. Basic stablecoin transfers work.

### Phase 2: Expense Management MVP (Weeks 5-10)

Build the complete expense management system as described in Part 1. This includes expense CRUD and receipt OCR, approval workflows and policy engine, reimbursement in stablecoin or local currency, and QuickBooks/Xero integration.

**Deliverables:** Complete expense management platform that can be used by early customers.

### Phase 3: Invoicing MVP + Kenya eTIMS (Weeks 11-18)

Build the invoicing system as described in Part 2 with mandatory Kenya eTIMS compliance. This includes invoice creation and management, multi-currency payment acceptance, payment detection and settlement, automated reminders, DigiTax API integration for eTIMS compliance, item registration with KRA, QR code generation for tax invoices, and callback handling for invoice status updates.

**Deliverables:** Businesses can send KRA-compliant invoices and receive payments in crypto or fiat. All invoices automatically submitted to eTIMS.

### Phase 4: Payroll MVP - Contractors (Weeks 19-24)

Build contractor payment features from Part 3. This includes contractor onboarding and management, contract generation and e-signatures, batch payments in multiple currencies, and basic compliance documentation.

**Deliverables:** Businesses can manage and pay contractors across African countries.

### Phase 5: Payroll - Employees (Weeks 25-32)

Extend payroll to support employees with tax calculations. This includes employee onboarding, tax calculators for Kenya, Nigeria, Ghana, and South Africa, payslip generation, and year-end tax document generation.

**Deliverables:** Full payroll system supporting both contractors and employees.

### Phase 6: Polish & Scale (Weeks 33-40)

Refine all products based on user feedback. This includes mobile apps for iOS and Android, advanced analytics and reporting, additional country support, API for third-party integrations, and performance optimization for scale.

**Deliverables:** Production-ready platform suitable for scaling to thousands of customers.

---

## Conclusion

This implementation guide provides a comprehensive blueprint for building Expendi Business as a complete financial management platform for African startups. By combining expense management (inspired by Expensify), crypto invoicing (inspired by Acctual), and payroll (inspired by Deel), the platform addresses the core financial pain points that African businesses face.

The key differentiator is the stablecoin-native architecture that runs through all three products. By building on crypto rails from the start, Expendi Business can offer faster settlements, lower fees, and more reliable payments than traditional banking infrastructure allows. This isn't just a feature — it's a fundamental architectural advantage that would be difficult for traditional fintech competitors to replicate.

For the Kenya pilot, eTIMS compliance through DigiTax integration ensures all invoices meet KRA requirements from day one. This regulatory compliance, combined with the stablecoin payment infrastructure, positions Expendi Business as a uniquely capable platform for Kenyan startups navigating both tax compliance and cross-border payment challenges.

The phased implementation approach allows for incremental delivery of value. Expense management provides the initial wedge to acquire customers, invoicing (with eTIMS compliance) expands revenue per customer and creates payment flow, and payroll represents the ultimate sticky product that makes Expendi Business indispensable to customers' operations.

Success factors to keep in mind include starting with the highest-quality receipt OCR from day one, building flexible approval workflows that adapt to different organization structures, making stablecoin payments feel invisible and automatic rather than complex, focusing on mobile-first design given African smartphone usage patterns, ensuring eTIMS compliance is seamless and automatic for users, and prioritizing reliability over features in early versions.




## References


- https://ke.docs.digitax.tech/docs/getting-started
- [Request Finance](https://www.request.finance/)



