using { prototype_salesorderApp_ai as db } from '../db/sales-model';

service SalesOrderService @(path: '/sales-order') {

    entity Customers as projection on db.Customers;

    entity Products as projection on db.Products;

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
}

type ProductSuggestion {
    productId   : String;
    productName : String;
}

type ClarificationRequest {
    question    : String;
    quantity    : Integer;
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
    reason        : String;
    unitPrice     : Decimal(9,2);
    unit          : String;
}

type RecommendationResult {
    success          : Boolean;
    message          : String;
    recommendations  : many ProductRecommendation;
}

action interpretOrderItems(
    orderRequest : String
) returns InterpretationResult;

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
}