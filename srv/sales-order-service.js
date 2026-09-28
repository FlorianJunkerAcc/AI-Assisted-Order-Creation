import cds from "@sap/cds";
import { OrchestrationClient } from "@sap-ai-sdk/orchestration";

// SELECT wird für Datenbankabfragen benötigt.
const { INSERT, SELECT, UPDATE } = cds.ql;
const BASE_PRICE_LIST_NAME =
    "Z_BASISPREISLISTE_FLORIANJUNKER";
const ENABLE_AI_RECOMMENDATION_REASONS =
    process.env.ENABLE_AI_RECOMMENDATION_REASONS === "true";

function getSalesCloudErrorCode(error) {
    const remoteError = error.reason || error.innererror || error;
    const status =
        remoteError.response?.status ||
        remoteError.status ||
        remoteError.statusCode ||
        error.statusCode;
    const responseData = remoteError.response?.data;
    const responseCode =
        responseData?.error?.code ||
        responseData?.code;
    return responseCode || (status ? `HTTP_${status}` : "REMOTE_ERROR");
}

function getSalesCloudErrorMessage(error) {
    const remoteError = error.reason || error.innererror || error;
    let responseData = remoteError.response?.data;
    if (typeof responseData === "string") {
        try {
            responseData = JSON.parse(responseData);
        } catch {
            return responseData;
        }
    }
    return (
        responseData?.error?.message?.value ||
        responseData?.error?.message ||
        remoteError.message ||
        error.message ||
        "Unknown Sales Cloud error"
    );
}

function getResultRows(result) {
    if (Array.isArray(result)) {
        return result;
    }
    if (Array.isArray(result?.value)) {
        return result.value;
    }
    if (Array.isArray(result?.d?.results)) {
        return result.d.results;
    }
    if (result?.d && typeof result.d === "object") {
        return [result.d];
    }
    return [];
}

async function generateRecommendationReasonsWithAI(recommendations) {
    const client = new OrchestrationClient({
        promptTemplating: {
            model: {
                name: "anthropic--claude-4.6-sonnet"
            }
        }
    });
    const response = await client.chatCompletion({
        messages: [
            {
                role: "system",
                content: "Write one short, friendly reason for each product " +
                    "recommendation using only its product name, order count, " +
                    "and total quantity. Return only JSON in the form " +
                    '{"recommendations":[{"productNumber":"...","reason":"..."}]}.'
            },
            {
                role: "user",
                content: JSON.stringify(recommendations.map((item) => ({
                    productNumber: item.productNumber,
                    productName: item.productName,
                    orderCount: item.orderCount,
                    totalQuantity: item.totalQuantity
                })))
            }
        ]
    });
    const parsedResponse = JSON.parse(response.getContent());
    if (!Array.isArray(parsedResponse.recommendations)) {
        throw new Error("AI response did not contain a recommendations array.");
    }
    const reasonsByProductNumber = new Map(
        parsedResponse.recommendations
            .filter((item) =>
                typeof item.productNumber === "string" &&
                typeof item.reason === "string" &&
                item.reason.trim()
            )
            .map((item) => [
                item.productNumber.toUpperCase(),
                item.reason.trim()
            ])
    );
    return recommendations.map((item) => ({
        ...item,
        reason: reasonsByProductNumber.get(
            item.productNumber.toUpperCase()
        ) || item.reason
    }));
}

function evaluateProductFilterValue(token, product) {
    if (Array.isArray(token)) {
        return evaluateProductFilter(token, product);
    }
    if (!token || typeof token !== "object") {
        return token;
    }
    if (token.xpr) {
        return evaluateProductFilter(token.xpr, product);
    }
    if (token.ref) {
        const property = token.ref[token.ref.length - 1];
        if (!["productNumber", "name", "productCategoryID"].includes(property)) {
            throw new Error(`Unsupported product filter property: ${property}`);
        }
        return product[property];
    }
    if (Object.prototype.hasOwnProperty.call(token, "val")) {
        return token.val;
    }
    if (token.func) {
        const args = token.args.map((arg) =>
            evaluateProductFilterValue(arg, product)
        );
        const value = String(args[0] ?? "");
        const search = String(args[1] ?? "");
        switch (token.func.toLowerCase()) {
        case "contains":
            return value.includes(search);
        case "startswith":
            return value.startsWith(search);
        case "endswith":
            return value.endsWith(search);
        case "tolower":
            return value.toLowerCase();
        case "toupper":
            return value.toUpperCase();
        case "substringof":
            return search.includes(value);
        default:
            throw new Error(`Unsupported product filter function: ${token.func}`);
        }
    }
    throw new Error("Unsupported product filter expression.");
}

function evaluateProductComparison(left, operator, right) {
    const normalizedOperator = operator.toLowerCase();
    if (normalizedOperator === "=" || normalizedOperator === "==") {
        return left === right;
    }
    if (normalizedOperator === "!=" || normalizedOperator === "<>") {
        return left !== right;
    }
    const value = String(left ?? "");
    const search = String(right ?? "");
    if (normalizedOperator === "contains") {
        return value.includes(search);
    }
    if (normalizedOperator === "startswith") {
        return value.startsWith(search);
    }
    if (normalizedOperator === "endswith") {
        return value.endsWith(search);
    }
    if (normalizedOperator === "like") {
        const pattern = search
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/%/g, ".*")
            .replace(/_/g, ".");
        return new RegExp(`^${pattern}$`).test(value);
    }
    throw new Error(`Unsupported product filter operator: ${operator}`);
}

function evaluateProductFilter(tokens, product) {
    let index = 0;

    const parsePrimary = () => {
        const token = tokens[index];
        if (token === "(") {
            index += 1;
            const result = parseOr();
            if (tokens[index] !== ")") {
                throw new Error("Invalid product filter expression.");
            }
            index += 1;
            return result;
        }
        if (token?.xpr) {
            index += 1;
            return evaluateProductFilter(token.xpr, product);
        }

        index += 1;
        const left = evaluateProductFilterValue(token, product);
        const operator = tokens[index];
        if (typeof operator === "string" &&
            !["and", "or", ")"].includes(operator.toLowerCase())) {
            index += 1;
            const right = evaluateProductFilterValue(tokens[index], product);
            index += 1;
            return evaluateProductComparison(left, operator, right);
        }
        return Boolean(left);
    };

    const parseAnd = () => {
        let result = parsePrimary();
        while (String(tokens[index]).toLowerCase() === "and") {
            index += 1;
            const next = parsePrimary();
            result = result && next;
        }
        return result;
    };

    const parseOr = () => {
        let result = parseAnd();
        while (String(tokens[index]).toLowerCase() === "or") {
            index += 1;
            const next = parseAnd();
            result = result || next;
        }
        return result;
    };

    const matches = parseOr();
    if (index !== tokens.length) {
        throw new Error("Invalid product filter expression.");
    }
    return matches;
}

// Implementierung des SalesOrderService.
// Diese Datei wird automatisch mit der gleichnamigen CDS-Service-Datei verbunden.
export default cds.service.impl(async function () {

    // Holt die Entity Products aus dem aktuellen SalesOrderService.
    const { Customers, Products } = this.entities;
    const salesCloud = await cds.connect.to("SalesCloud");
    const {
        CorporateAccountCollection,
        ProductCollection,
        InternalPriceDiscountListItemsCollection,
        CustomerOrderCollection,
        CustomerOrderItemCollection
    } = salesCloud.entities;

    const loadSalesCloudProducts = async () => {
        const [products, priceItems] = await Promise.all([
            salesCloud.run(
                SELECT.from(ProductCollection).where({
                    Status: "2"
                })
            ),
            salesCloud.run(
                SELECT.from(InternalPriceDiscountListItemsCollection).where({
                    PriceDiscountListID: BASE_PRICE_LIST_NAME
                })
            )
        ]);

        const pricesByProduct = new Map();

        for (const priceItem of priceItems) {
            if (priceItem.ProductID) {
                pricesByProduct.set(
                    String(priceItem.ProductID).trim().toUpperCase(),
                    Number(priceItem.Amount) || 0
                );
            }
        }

        return products.map((product) => ({
            ID: product.ObjectID,
            productNumber: product.ProductID,
            name: product.Description || product.Name,
            productCategoryID: product.ProductCategoryID,
            description: product.Description || product.Name,
            price: pricesByProduct.get(
                String(product.ProductID).trim().toUpperCase()
            ) ??
                0,
            unit: product.BaseUOMText
        }));
    };

    this.on("READ", Customers, async () => {
        const customers = await salesCloud.run(
            SELECT.from(CorporateAccountCollection).where({
                LifeCycleStatusCode: "2",
                RoleCode: "CRM000"
            })
        );

        return customers.map((customer) => ({
            ID: customer.ObjectID,
            customerNumber: customer.AccountID,
            name: customer.Name,
            address: customer.FormattedPostalAddressDescription,
            city: ""
        }));
    });

    this.on("READ", Products, async (req) => {
        const products = await loadSalesCloudProducts();
        const filters = req.query?.SELECT?.where;
        if (!filters?.length) {
            return products;
        }
        try {
            return products.filter((product) =>
                evaluateProductFilter(filters, product)
            );
        } catch (error) {
            return req.reject(400, error.message);
        }
    });

    this.before("CREATE", "SalesOrders", async (req) => {
        const customerId = req.data.customer_ID;
        const orderItems = req.data.items || [];

        if (!customerId) {
            return req.reject(400, "A customer must be selected.");
        }

        if (!orderItems.length) {
            return req.reject(
                400,
                "At least one product must be added to the order."
            );
        }

        const [customer] = await salesCloud.run(
            SELECT.from(CorporateAccountCollection).where({
                ObjectID: customerId,
                LifeCycleStatusCode: "2",
                RoleCode: "CRM000"
            })
        );

        if (!customer) {
            return req.reject(
                400,
                "The selected customer is not an active Sales Cloud customer."
            );
        }

        const products = await loadSalesCloudProducts();
        const productById = new Map(
            products.map((product) => [product.ID, product])
        );

        const positionedOrderItems = orderItems.map((item, index) => ({
            ...item,
            position: (index + 1) * 10
        }));
        req.data.items = positionedOrderItems;

        for (const item of positionedOrderItems) {
            const product = productById.get(item.product_ID);

            if (!product) {
                return req.reject(
                    400,
                    "The selected product is not an active Sales Cloud product."
                );
            }

            const localProduct = await SELECT.one
                .from(Products)
                .where({ ID: product.ID });

            if (localProduct) {
                await UPDATE(Products, product.ID).with(product);
            } else {
                await INSERT.into(Products).entries(product);
            }
        }

        const localCustomer = await SELECT.one
            .from(Customers)
            .where({ ID: customer.ObjectID });

        if (localCustomer) {
            await UPDATE(Customers, customer.ObjectID).with({
                customerNumber: customer.AccountID,
                name: customer.Name,
                address: customer.Address,
                city: ""
            });
        } else {
            await INSERT.into(Customers).entries({
                ID: customer.ObjectID,
                customerNumber: customer.AccountID,
                name: customer.Name,
                address: customer.Address,
                city: ""
            });
        }

        const orderPayload = {
            BuyerPartyID: customer.AccountID,
            SalesUnitPartyID: "US1100"
        };
        let createdOrder;
        try {
            createdOrder = await salesCloud.run(
                INSERT.into(CustomerOrderCollection).entries(orderPayload)
            );
        } catch (error) {
            console.error("Sales Cloud order creation failed:", error);
            return req.reject(
                502,
                `SALES_CLOUD_ORDER_CREATE_${getSalesCloudErrorCode(error)}: ` +
                    getSalesCloudErrorMessage(error)
            );
        }

        const createdOrderEntity = Array.isArray(createdOrder)
            ? createdOrder[0]
            : createdOrder?.d?.results?.[0] ||
                createdOrder?.d ||
                createdOrder?.value?.[0] ||
                createdOrder;
        const salesOrderID =
            createdOrderEntity?.ID || createdOrderEntity?.id;
        if (!salesOrderID) {
            return req.reject(
                502,
                "SALES_CLOUD_ORDER_ID_MISSING: SAP created the order but " +
                    "did not return its order number; order items were not sent."
            );
        }

        req.data.orderNumber = String(salesOrderID);
        const itemPayloads = positionedOrderItems.map((item) => {
            const product = productById.get(item.product_ID);
            return {
                SalesOrderID: String(salesOrderID),
                ProductID: product.productNumber,
                ID: String(item.position),
                Quantity: Number(item.quantity)
            };
        });

        try {
            for (const itemPayload of itemPayloads) {
                await salesCloud.run(
                    INSERT.into(CustomerOrderItemCollection).entries(
                        itemPayload
                    )
                );
            }
        } catch (error) {
            console.error("Sales Cloud order item creation failed:", error);
            return req.reject(
                502,
                `SALES_CLOUD_ORDER_ITEMS_CREATE_${getSalesCloudErrorCode(error)}: ` +
                    `Order ${salesOrderID} was created, but item transfer failed; ` +
                    "the header and any earlier items may already exist. " +
                    getSalesCloudErrorMessage(error)
            );
        }
        req.data.salesCloudOrderPayload = JSON.stringify(orderPayload);
        req.data.salesCloudItemPayloads = JSON.stringify(itemPayloads);
    });

    /**
     * Handler für die CAP Action interpretOrderItems.
     *
     * Die Action:
     * 1. empfängt einen natürlichsprachlichen Bestelltext,
     * 2. liest den Produktkatalog aus SQLite,
     * 3. sendet Text und Produktkatalog an SAP AI Core,
     * 4. validiert die AI-Antwort,
     * 5. ergänzt echte Preise aus der Produktdatenbank,
     * 6. gibt nur vorgeschlagene Auftragspositionen zurück.
     *
     * Die Action speichert keinen Sales Order.
     */
    this.on("interpretOrderItems", async (req) => {

        // Liest den Parameter orderRequest aus dem Request.
        //
        // Beispiel:
        // "Add 5 Ferrero Rocher and 10 Kinder Bueno"
        const { orderRequest } = req.data;

        // Prüft, ob überhaupt eine Eingabe vorhanden ist.
        if (!orderRequest?.trim()) {
            return req.reject(
                400,
                "The order request must not be empty."
            );
        }

        console.log("Order request received:", orderRequest);

        try {
            /**
             * Schritt 1:
             * Aktive Produkte aus der SAP Sales Cloud lesen.
             *
             * loadSalesCloudProducts liest ProductCollection mit Status 2
             * und ergänzt den Preis aus der Basispreisliste.
             */
            const products = await loadSalesCloudProducts();

            // Abbruch, falls der Produktkatalog leer ist.
            if (!products.length) {
                return req.reject(
                    500,
                    "No products are available in the product catalog."
                );
            }

            console.log("Available products:", products);

            /**
             * Schritt 2:
             * Den Sales-Cloud-Produktkatalog für Sonnet in einen einfachen
             * Text umwandeln.
             *
             * Beispielzeile:
             * UUID | P1001 | Ferrero Rocher 16 Pieces
             *
             * Preise werden bewusst nicht an Sonnet übergeben.
             * Preise kommen später ausschließlich aus der Datenbank.
             */
            const productCatalog = products
                .map(
                    (product) =>
                        `${product.ID} | ${product.productNumber} | ${product.name}`
                )
                .join("\n");

            /**
             * Schritt 3:
             * Verbindung zum Orchestration Service von SAP AI Core
             * konfigurieren.
             *
             * Verwendetes Modell:
             * Anthropic Claude 4.6 Sonnet
             */
            const client = new OrchestrationClient({
                promptTemplating: {
                    model: {
                        name: "anthropic--claude-4.6-sonnet"
                    }
                }
            });

            /**
             * Schritt 4:
             * Eingabetext und erlaubten Produktkatalog an Sonnet senden.
             *
             * Der System Prompt grenzt die Aufgabe bewusst ein:
             * Sonnet darf nur Produkte aus dem übergebenen Katalog verwenden.
             * Sonnet darf keinen Auftrag speichern oder Preise erfinden.
             */
            const response = await client.chatCompletion({
                messages: [
                    {
                        role: "system",
                       content: `You extract order items from a sales representative's input.

You must match every requested product against the following product catalog:

${productCatalog}

For every requested product, decide for yourself whether you are confident
which catalog product is meant, or whether the request is ambiguous.

A request is ambiguous if the wording could reasonably match more than one
product in the catalog (for example, a brand name without a specific variant).

Rules:

- If you are confident which single product is meant, return it as a resolved item.
- If you are not confident, do not guess. Instead, return clarification_required
  and list every catalog product that could reasonably match, as suggestions.
- Base your confidence only on how well the request matches the catalog.
- Do not invent products, product IDs, prices, or quantities.
- Do not create, save, or submit a sales order.
- Do not select or modify a customer.
- Do not generate an order number.
- Return only valid JSON.
- Do not wrap the JSON in Markdown code fences.

Return exactly this structure:

{
  "items": [
    {
      "status": "resolved",
      "productId": "ID from catalog",
      "productName": "exact name from catalog",
      "quantity": 1
    },
    {
      "status": "clarification_required",
      "question": "Which product did you mean?",
      "quantity": 1,
      "suggestions": [
        {
          "productId": "ID from catalog",
          "productName": "exact name from catalog"
        }
      ]
    }
  ]
}`
                    },
                    {
                        role: "user",
                        content: orderRequest
                    }
                ]
            });

            /**
             * Schritt 5:
             * Antwort von Sonnet als Text auslesen.
             *
             * Erwartete Antwort:
             *
             * {
             *   "items": [
             *     {
             *       "productId": "...",
             *       "productName": "Ferrero Rocher 16 Pieces",
             *       "quantity": 5
             *     }
             *   ]
             * }
             */
            const aiResponse = response.getContent();

            console.log("Raw AI response:", aiResponse);

            /**
             * Schritt 6:
             * JSON-Text in ein JavaScript-Objekt umwandeln.
             */
            const parsedResponse = JSON.parse(aiResponse);

            // Prüft, ob die erwartete items-Liste vorhanden ist.
            if (!Array.isArray(parsedResponse.items)) {
                throw new Error(
                    "The AI response does not contain a valid items array."
                );
            }

            // Es muss mindestens eine Position erkannt worden sein.
            if (parsedResponse.items.length === 0) {
                return {
                    success: false,
                    message: "No matching products were identified.",
                    items: []
                };
            }

            /**
             * Schritt 7:
             * Jedes AI-Ergebnis gegen die echte Produktdatenbank prüfen.
             *
             * Sonnet liefert nur:
             * - Produkt-ID
             * - Produktname
             * - Menge
             *
             * CAP ergänzt anschließend:
             * - Produktnummer
             * - echten Preis
             * - Gesamtpreis
             */
const validatedItems = [];
const clarifications = [];

for (const item of parsedResponse.items) {

    // Fall 1: Sonnet ist sich sicher
    if (item.status === "resolved") {

        const product = products.find(
            (candidate) => candidate.ID === item.productId
        );

        if (!product) {
            throw new Error(
                `Unknown product returned by AI: ${item.productName}`
            );
        }

        const quantity = Number(item.quantity);
        const unitPrice = Number(product.price);

        if (!Number.isInteger(quantity) || quantity <= 0) {
            throw new Error(
                `Invalid quantity for product: ${product.name}`
            );
        }

        validatedItems.push({
            product_ID: product.ID,
            productNumber: product.productNumber,
            productName: product.name,
            unit: product.unit,
            quantity,
            unitPrice,
            totalPrice: Number((unitPrice * quantity).toFixed(2)),
            confidence: 1,
            message: ""
        });

    // Fall 2: Sonnet ist sich nicht sicher
    } else if (item.status === "clarification_required") {

        const validatedSuggestions = (item.suggestions || []).map((suggestion) => {
            const product = products.find(
                (candidate) => candidate.ID === suggestion.productId
            );

            if (!product) {
                throw new Error(
                    `Unknown suggested product returned by AI: ${suggestion.productName}`
                );
            }

            return {
                productId: product.ID,
                productName: product.name
            };
        });

        clarifications.push({
            question: item.question,
            quantity: Number(item.quantity) || 1,
            suggestions: validatedSuggestions
        });

    } else {
        throw new Error(
            `Unknown item status returned by AI: ${item.status}`
        );
    }
}

            console.log(
                "Validated order items:",
                validatedItems
            );
console.log("Clarifications needed:", clarifications);
            /**
             * Schritt 8:
             * Validierte Positionen an die Fiori-App zurückgeben.
             *
             * Es wird weiterhin kein Sales Order gespeichert.
             */
           const hasClarifications = clarifications.length > 0;

let message;

if (validatedItems.length > 0 && hasClarifications) {
    message = `${validatedItems.length} product(s) identified. ` +
               `${clarifications.length} product(s) need clarification.`;
} else if (hasClarifications) {
    message = `${clarifications.length} product(s) need clarification.`;
} else {
    message = `${validatedItems.length} product(s) successfully identified.`;
}

return {
    success: true,
    message,
    items: validatedItems,
    clarifications
};

        } catch (error) {
            /**
             * Fehler können beispielsweise entstehen durch:
             * - SAP-AI-Core-Verbindungsfehler
             * - ungültiges JSON
             * - unbekannte Produkt-ID
             * - ungültige Menge
             * - fehlenden Produktpreis
             */
            console.error(
                "Order item interpretation failed:",
                error
            );

            return req.reject(
                500,
                `Order item interpretation failed: ${error.message}`
            );
        }
    });

    /**
     * Reads customer order history and returns catalog products ranked by
     * distinct order count, without creating or changing any orders.
     */
    this.on("recommendProducts", async (req) => {
        const { customerId, excludedProductIDs = "[]" } = req.data;
        if (!customerId) {
            return req.reject(400, "A customer must be selected.");
        }

        let excludedProductIDsList;
        try {
            excludedProductIDsList = JSON.parse(excludedProductIDs || "[]");
        } catch {
            return req.reject(
                400,
                "The excluded product ID list must be valid JSON."
            );
        }
        if (!Array.isArray(excludedProductIDsList) ||
            excludedProductIDsList.some((id) => typeof id !== "string")) {
            return req.reject(
                400,
                "The excluded product IDs must be a JSON array of strings."
            );
        }
        const excludedProductIDsSet = new Set(excludedProductIDsList);

        try {
            let customer = await SELECT.one
                .from(Customers)
                .where({ ID: customerId });
            if (!customer?.customerNumber) {
                let salesCloudCustomer;
                try {
                    [salesCloudCustomer] = await salesCloud.run(
                        SELECT.from(CorporateAccountCollection).where({
                            ObjectID: customerId
                        })
                    );
                } catch (error) {
                    console.error(
                        "Could not resolve customer in SAP Sales Cloud:",
                        error
                    );
                    const lookupError = new Error(
                        `SALES_CLOUD_CUSTOMER_LOOKUP_${getSalesCloudErrorCode(error)}: ` +
                            getSalesCloudErrorMessage(error)
                    );
                    lookupError.statusCode = 502;
                    throw lookupError;
                }
                customer = salesCloudCustomer
                    ? {
                        customerNumber: salesCloudCustomer.AccountID
                    }
                    : customer;
            }
            if (!customer?.customerNumber) {
                return req.reject(
                    404,
                    "The selected customer could not be found in the local " +
                        "customer catalog or SAP Sales Cloud."
                );
            }

            let historicalOrders;
            try {
                historicalOrders = getResultRows(await salesCloud.run(
                    SELECT.from(CustomerOrderCollection).where({
                        BuyerPartyID: customer.customerNumber
                    })
                ));
            } catch (error) {
                console.error(
                    "Could not read SAP Sales Cloud order history:",
                    error
                );
                return req.reject(
                    502,
                    `SALES_CLOUD_ORDER_HISTORY_${getSalesCloudErrorCode(error)}: ` +
                        getSalesCloudErrorMessage(error)
                );
            }

            if (historicalOrders.length === 0) {
                return {
                    success: false,
                    message: "No order history was found for this customer.",
                    recommendations: []
                };
            }

            const orderIDs = [...new Set(historicalOrders
                .map((order) => order.ID)
                .filter((id) => typeof id === "string" && id.length > 0))];
            if (orderIDs.length === 0) {
                return {
                    success: false,
                    message: "The customer's order history contains no order IDs.",
                    recommendations: []
                };
            }

            const historicalItems = [];
            try {
                for (let start = 0; start < orderIDs.length; start += 8) {
                    const batch = orderIDs.slice(start, start + 8);
                    const batchItems = await Promise.all(
                        batch.map(async (salesOrderID) => ({
                            salesOrderID,
                            items: getResultRows(
                                await salesCloud.run(
                                    SELECT.from(CustomerOrderItemCollection)
                                        .where({ SalesOrderID: salesOrderID })
                                )
                            )
                        }))
                    );
                    historicalItems.push(
                        ...batchItems.flatMap(({ salesOrderID, items }) =>
                            items.map((item) => ({ salesOrderID, item }))
                        )
                    );
                }
            } catch (error) {
                console.error(
                    "Could not read SAP Sales Cloud order items:",
                    error
                );
                return req.reject(
                    502,
                    `SALES_CLOUD_ORDER_ITEMS_HISTORY_${getSalesCloudErrorCode(error)}: ` +
                        getSalesCloudErrorMessage(error)
                );
            }

            if (historicalItems.length === 0) {
                return {
                    success: false,
                    message: "No order items were found in this customer's history.",
                    recommendations: []
                };
            }

            const aggregatesByProductNumber = new Map();
            for (const { salesOrderID, item } of historicalItems) {
                const productNumber = String(item.ProductID || "")
                    .trim()
                    .toUpperCase();
                const quantity = Number(item.Quantity);
                if (!productNumber || !Number.isFinite(quantity) ||
                    quantity <= 0) {
                    continue;
                }
                let aggregate = aggregatesByProductNumber.get(productNumber);
                if (!aggregate) {
                    aggregate = {
                        productNumber,
                        orderIDs: new Set(),
                        totalQuantity: 0
                    };
                    aggregatesByProductNumber.set(productNumber, aggregate);
                }
                aggregate.orderIDs.add(salesOrderID);
                aggregate.totalQuantity += quantity;
            }

            const localProducts = await SELECT.from(Products);
            const localProductsByNumber = new Map(
                localProducts.map((product) => [
                    String(product.productNumber || "").trim().toUpperCase(),
                    product
                ])
            );
            let salesCloudProducts;
            try {
                salesCloudProducts = await loadSalesCloudProducts();
            } catch (error) {
                console.error(
                    "Could not resolve historical products in the active " +
                        "SAP Sales Cloud catalog:",
                    error
                );
                return req.reject(
                    502,
                    `SALES_CLOUD_PRODUCT_CATALOG_${getSalesCloudErrorCode(error)}: ` +
                        getSalesCloudErrorMessage(error)
                );
            }
            const salesCloudProductsByNumber = new Map(
                salesCloudProducts.map((product) => [
                    String(product.productNumber || "").trim().toUpperCase(),
                    product
                ])
            );
            const recommendations = [];
            for (const aggregate of aggregatesByProductNumber.values()) {
                const localProduct = localProductsByNumber.get(
                    aggregate.productNumber
                );
                if (!localProduct) {
                    console.warn(
                        "Skipping historical product absent from local catalog:",
                        aggregate.productNumber
                    );
                    continue;
                }
                const salesCloudProduct = salesCloudProductsByNumber.get(
                    aggregate.productNumber
                );
                if (!salesCloudProduct) {
                    console.warn(
                        "Skipping historical product absent from active " +
                            "Sales Cloud catalog:",
                        aggregate.productNumber
                    );
                    continue;
                }
                if (excludedProductIDsSet.has(String(salesCloudProduct.ID))) {
                    continue;
                }
                const unitPrice = Number(localProduct.price);
                if (!Number.isFinite(unitPrice)) {
                    console.warn(
                        "Skipping recommended product without a catalog price:",
                        localProduct.productNumber
                    );
                    continue;
                }
                const orderCount = aggregate.orderIDs.size;
                recommendations.push({
                    product_ID: salesCloudProduct.ID,
                    productNumber: localProduct.productNumber,
                    productName: localProduct.name,
                    orderCount,
                    totalQuantity: Math.round(aggregate.totalQuantity),
                    reason:
                        `Ordered in ${orderCount} distinct orders ` +
                        `(total ${aggregate.totalQuantity} units) in this ` +
                        "customer's order history.",
                    unitPrice,
                    unit: localProduct.unit || ""
                });
            }

            if (recommendations.length === 0) {
                return {
                    success: false,
                    message: aggregatesByProductNumber.size === 0
                        ? "No products could be aggregated from the order history."
                        : "No historical products matched the local catalog " +
                            "or all matching products are already in the draft.",
                    recommendations: []
                };
            }

            recommendations.sort((left, right) =>
                right.orderCount - left.orderCount ||
                right.totalQuantity - left.totalQuantity
            );
            let topRecommendations = recommendations.slice(0, 5);
            if (ENABLE_AI_RECOMMENDATION_REASONS) {
                try {
                    topRecommendations =
                        await generateRecommendationReasonsWithAI(
                            topRecommendations
                        );
                } catch (error) {
                    console.error(
                        "AI recommendation reason generation failed; " +
                            "using history-based reasons:",
                        error
                    );
                }
            }

            return {
                success: true,
                message: "Product recommendations are based on this customer's order history.",
                recommendations: topRecommendations
            };
        } catch (error) {
            const statusCode = Number(
                error.statusCode || error.status || error.code
            );
            if (statusCode >= 400 && statusCode < 600) {
                return req.reject(statusCode, error.message);
            }
            console.error("Product recommendations failed:", error);
            return req.reject(
                500,
                `PRODUCT_RECOMMENDATIONS_FAILED: ${error.message}`
            );
        }
    });
});