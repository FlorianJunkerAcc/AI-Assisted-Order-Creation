@path: '/sap/c4c/odata/v1/c4codataapi'
service SalesCloud {
    @readonly
    entity CorporateAccountCollection {
        key ObjectID             : UUID;
            AccountID            : String(40);
            Name                 : String(255);
            Address              : String(255);
            LifeCycleStatusCode  : String(2);
            RoleCode             : String(20);
    }

    @readonly
    entity ProductCollection {
        key ObjectID : UUID;
            ID       : String(40);
            ProductID : String(40);
            Name     : String(255);
            Description : String(255);
            Status   : String(2);
    }

    @readonly
    entity InternalPriceDiscountListItemsCollection {
        key ObjectID : UUID;
            InternalPriceDiscountListID : String(40);
            ProductID : String(40);
            ProductObjectID : UUID;
            Price : Decimal(15, 3);
    }
}