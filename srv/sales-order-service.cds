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

action interpretOrderItems(
    orderRequest : String
) returns InterpretationResult;
}