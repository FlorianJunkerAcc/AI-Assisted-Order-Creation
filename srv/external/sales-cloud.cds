@path: '/sap/c4c/odata/v1/c4codataapi'
service SalesCloud {
    @readonly
    entity CorporateAccountCollection {
        key ObjectID             : String(40);
            AccountID            : String(40);
            Name                 : String(255);
            Address              : String(255);
            LifeCycleStatusCode  : String(2);
            RoleCode             : String(20);
    }

    @readonly
    entity ProductCollection {
        key ObjectID : String(40);
            ID       : String(40);
            ProductID : String(40);
            Name     : String(255);
            Description : String(255);
            Status   : String(2);
    }

    @readonly
    entity InternalPriceDiscountListItemsCollection {
        key ObjectID      : String(40);
            ParentObjectID : String(40);
            PriceDiscountListID : String(40);
            ProductID      : String(40);
            Amount         : Decimal(15, 3);
    }
}