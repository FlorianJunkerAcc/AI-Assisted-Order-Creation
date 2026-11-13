using { prototype_salesorderApp_ai as db } from '../db/sales-model';

service SalesOrderService @(path: '/sales-order') {

    entity Customers as projection on db.Customers;

    entity Products as projection on db.Products;

    @readonly
    entity ProductDependencies as projection on db.ProductDependencies;

    entity SalesOrders as projection on db.SalesOrders;

    entity SalesOrderItems as projection on db.SalesOrderItems;

    type InterpretedOrderItem {
    product_ID     : UUID;
    productNumber : String;
    productName   : String;
    unit          : String;
    quantity      : Integer;
    unitPrice     : Decimal(9,2);
    totalPrice    : Decimal(9,2);
    confidence    : Decimal(3,2);
    message       : String;
    // "add" | "update" | "remove"; position verweist bei update/remove
    // auf eine bestehende Auftragsposition.
    action        : String;
    position      : Integer;
}

type ProductSuggestion {
    productId   : String;
    productName : String;
}

type ClarificationRequest {
    question    : String;
    quantity    : Integer;
    action      : String;
    position    : Integer;
    suggestions : many ProductSuggestion;
}

type InterpretationResult {
    success       : Boolean;
    message       : String;
    items         : many InterpretedOrderItem;
    clarifications: many ClarificationRequest;
}

type ProductRecommendation {
    product_ID    : UUID;
    productNumber : String;
    productName   : String;
    orderCount    : Integer;
    totalQuantity : Integer;
    averageQuantity : Integer;
    quantity      : Integer;
    reason        : String;
    unitPrice     : Decimal(9,2);
    totalPrice    : Decimal(15,2);
    unit          : String;
    totalOrders      : Integer;
    frequencyPercent : Integer;
    reasonProduct    : String;
    reasonQuantity   : String;
    reasonDecision   : String;
}

type RecommendationResult {
    success          : Boolean;
    message          : String;
    recommendations  : many ProductRecommendation;
}

action interpretOrderItems(
    orderRequest : String,
    // JSON-Array der aktuellen Positionen: [{position, product_ID, productName, quantity}]
    currentItems : LargeString
) returns InterpretationResult;

type DependencyResult {
    // Hinweis fuer den Nutzer, welche Pflicht-Unterprodukte ergaenzt wurden
    // (leer, wenn das Produkt keine hat).
    message : String;
    items   : many InterpretedOrderItem;
    // Hinterlegte Unterprodukte, die im aktiven Katalog fehlen.
    missing : many String;
}

// Liefert die Pflicht-Unterprodukte zu einem Produkt (in der hinterlegten
// Reihenfolge). Die Menge je Unterprodukt ist die hinterlegte Menge mal
// quantity (Menge des Hauptprodukts).
action getProductDependencies(
    productId : String,
    quantity  : Integer
) returns DependencyResult;

action recommendProducts(
    customerId : UUID,
    excludedProductIDs : LargeString
) returns RecommendationResult;

// ---------------------------------------------------------------------
// AI Order Validation — bitte in deine bestehende sales-order-service.cds
// innerhalb des "service SalesOrderService { ... }" Blocks ergänzen,
// z. B. direkt neben den bestehenden Recommendation-Typen.
//
// Hinweis: "items" wird bewusst als JSON-String übergeben (analog zum
// bereits vorhandenen Parameter "excludedProductIDs" bei
// recommendProducts), nicht als "many"-Collection-Parameter. Das folgt
// eurem bestehenden Muster und vermeidet mögliche Kompatibilitätsprobleme
// mit komplexen Collection-Parametern bei OData-V4-Actions.
// ---------------------------------------------------------------------

type OrderValidationWarning {
    position    : Integer;
    productName : String;
    warningType : String;
    message     : String;
}

type OrderValidationResult {
    success  : Boolean;
    message  : String;
    warnings : many OrderValidationWarning;
}

action validateOrderItems(
    customerId : UUID,
    // JSON-kodiertes Array von { position, product_ID, quantity }
    items      : String
) returns OrderValidationResult;

type PicoComposedReply {
    reply : String;
}

// Verbindet Teilantworten (JSON-Array aus Strings) zu einer fluessigen Antwort.
action composeReply(
    parts : String
) returns PicoComposedReply;

type PicoRouteStep {
    intent            : String;
    // Der zu diesem Schritt gehoerende Teil des Befehls.
    command           : String;
    customerReference : String;
}

type PicoRouteResult {
    // "ok" | "clarification_required" | "multiple_intents" | "unknown_intent"
    status  : String;
    // "add_items" | "recommend_products" | "validate_order" | "" (leer, falls status != "ok")
    intent  : String;
    // Für "ok": kurze Bestätigung. Für die anderen Status: Rückfrage bzw.
    // Erklärung, die dem Nutzer direkt angezeigt wird.
    message : String;
    // Nur bei intent "copy_last_order": der im Befehl genannte Kunde
    // (Name/Nummer), sonst leer.
    customerReference : String;
    // Alle Schritte des Befehls in der Reihenfolge der Ausfuehrung
    // (nur bei status "ok").
    steps   : many PicoRouteStep;
    // Sprache des Nutzerbefehls: "de" (Deutsch) oder "en" (alles andere).
    language : String;
}

type PicoTranslation {
    text : String;
}

// Uebersetzt eine (englische) PICO-Chatnachricht in die Sprache des Nutzers.
// Fuer language "en" wird der Text unveraendert zurueckgegeben.
action translateReply(
    text     : String,
    language : String
) returns PicoTranslation;

action routeAiCommand(
    command : String
) returns PicoRouteResult;

type CustomerMatchSuggestion {
    customerId     : String;
    customerNumber : String;
    customerName   : String;
}

type CustomerSelectionResult {
    // "resolved" | "clarification_required"
    status         : String;
    // Nur befüllt, wenn status = "resolved"
    customerId     : String;
    customerNumber : String;
    customerName   : String;
    // Nur befüllt, wenn status = "clarification_required"
    question       : String;
    suggestions    : many CustomerMatchSuggestion;
}

action selectCustomer(
    command : String
) returns CustomerSelectionResult;


type OrderDraftItem {
    product_ID       : String;
    productNumber    : String;
    productName      : String;
    unit             : String;
    quantity         : Integer;
    unitPrice        : Decimal(15, 2);
    totalPrice       : Decimal(15, 2);
    decision         : String;
    orderCount       : Integer;
    totalOrders      : Integer;
    frequencyPercent : Integer;
    reasonProduct    : String;
    reasonQuantity   : String;
    reasonDecision   : String;
}

type OrderDraftResult {
    success        : Boolean;
    message        : String;
    analyzedOrders : Integer;
    autoItems      : many OrderDraftItem;
    suggestions    : many OrderDraftItem;
}

action generateOrderDraft(customerId : String, excludedProductIDs : String) returns OrderDraftResult;

type CopiedOrderItem {
    product_ID    : String;
    productNumber : String;
    productName   : String;
    unit          : String;
    quantity      : Integer;
    unitPrice     : Decimal(15, 2);
    totalPrice    : Decimal(15, 2);
}

type CopyOrderResult {
    success     : Boolean;
    message     : String;
    orderNumber : String;
    orderDate   : String;
    items       : many CopiedOrderItem;
}

// Liest die zuletzt angelegte Order des Kunden aus der Sales Cloud und
// liefert deren Positionen zum Uebernehmen in den Entwurf. Aendert nichts
// in der Sales Cloud.
action copyLastOrder(customerId : String) returns CopyOrderResult;

}