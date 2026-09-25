@path: '/sap/c4c/odata/v1/c4codataapi'
service SalesCloud {
    @readonly
    entity CorporateAccountCollection {
        key ObjectID             : UUID;
            AccountID            : String(40);
            Name                 : String(255);
            LifeCycleStatusCode  : String(2);
            RoleCode             : String(20);
    }
}