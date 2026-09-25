sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"com/prototype/salesorderai/salesorderui/test/integration/pages/SalesOrdersMain.gen"
], function (JourneyRunner, SalesOrdersMainGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('com/prototype/salesorderai/salesorderui') + '/test/flp.html#app-preview',
        pages: {
			onTheSalesOrdersMainGenerated: SalesOrdersMainGenerated
        },
        async: true
    });

    return runner;
});

