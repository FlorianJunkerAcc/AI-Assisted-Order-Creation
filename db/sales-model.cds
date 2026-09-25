namespace prototype_salesorderApp_ai;

using { cuid, managed } from '@sap/cds/common';

entity Customers : cuid, managed {
    customerNumber : String(10);
    name           : String(100);
    address        : String(255);
    city           : String(100);
}

entity Products : cuid, managed {
    productNumber : String(20);
    name          : String(100);
    productCategoryID : String(40);
    description   : String(255);
    price         : Decimal(9,2);
    unit          : String(10);
}

entity SalesOrders : cuid, managed {
    orderNumber : String(20);
    customer    : Association to Customers;
    status      : String(20);
    items       : Composition of many SalesOrderItems
                    on items.order = $self;
}

entity SalesOrderItems : cuid, managed {
    order    : Association to SalesOrders;
    product  : Association to Products;
    quantity : Integer;
    price    : Decimal(9,2);
}