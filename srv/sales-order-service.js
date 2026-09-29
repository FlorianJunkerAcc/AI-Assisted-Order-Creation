import cds from "@sap/cds";
import { OrchestrationClient } from "@sap-ai-sdk/orchestration";

// SELECT wird für Datenbankabfragen benötigt.
const { INSERT, SELECT, UPDATE } = cds.ql;

const BASE_PRICE_LIST_NAME =
    "Z_BASISPREISLISTE_FLORIANJUNKER";

const ENABLE_AI_RECOMMENDATION_REASONS =
    process.env.ENABLE_AI_RECOMMENDATION_REASONS === "true";

// ---------------------------------------------------------------------
// Gewichtung für den kombinierten Empfehlungs-Score (recommendProducts).
// ---------------------------------------------------------------------
const RELATIVE_FREQUENCY_WEIGHT = 0.5;
const ABSOLUTE_FREQUENCY_WEIGHT = 0.5;

// ---------------------------------------------------------------------
// Schwellenwerte für validateOrderItems (AI Order Validation).
// ---------------------------------------------------------------------
const MIN_ORDERS_FOR_VALIDATION = 3;
const RARE_CATEGORY_THRESHOLD = 0.15;
const QUANTITY_HIGH_FACTOR = 2.0;
const QUANTITY_LOW_FACTOR = 0.5;
const MIN_AVERAGE_FOR_LOW_CHECK = 2;

// ---------------------------------------------------------------------
// PICO Intent Router (routeAiCommand).
//
// PICO_ALLOWED_STATUSES: die vier möglichen Router-Ergebnisse.
// PICO_ALLOWED_INTENTS: die drei konkreten Funktionen, die PICO an den
//   Controller weiterreichen kann, wenn status === "ok".
// ---------------------------------------------------------------------
const PICO_ALLOWED_STATUSES = [
    "ok",
    "clarification_required",
    "multiple_intents",
    "unknown_intent"
];
const PICO_ALLOWED_INTENTS = [
    "add_items",
    "recommend_products",
    "validate_order"
];

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

function average(numbers) {
    return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

/**
 * Berechnet für eine Liste von Produkt-Aggregaten einen kombinierten
 * Ranking-Score aus relativer und absoluter Bestellhäufigkeit.
 */
function rankRecommendationsByFrequency(recommendations, totalOrders) {
    const maxOrderCount = Math.max(
        ...recommendations.map((item) => item.orderCount),
        1
    );

    const ranked = recommendations.map((item) => {
        const relativeFrequency = totalOrders > 0
            ? item.orderCount / totalOrders
            : 0;

        const normalizedAbsoluteFrequency =
            item.orderCount / maxOrderCount;

        const score =
            (relativeFrequency * RELATIVE_FREQUENCY_WEIGHT) +
            (normalizedAbsoluteFrequency * ABSOLUTE_FREQUENCY_WEIGHT);

        return {
            ...item,
            totalOrders,
            relativeFrequency: Number(relativeFrequency.toFixed(4)),
            score: Number(score.toFixed(4))
        };
    });

    ranked.sort((left, right) =>
        right.score - left.score ||
        right.orderCount - left.orderCount ||
        right.totalQuantity - left.totalQuantity
    );

    return ranked;
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
                    "recommendation using its product name, order count, " +
                    "relative order frequency (as a percentage), and average " +
                    "quantity per order. Return only JSON in the form " +
                    '{"recommendations":[{"productNumber":"...","reason":"..."}]}.'
            },
            {
                role: "user",
                content: JSON.stringify(recommendations.map((item) => ({
                    productNumber: item.productNumber,
                    productName: item.productName,
                    orderCount: item.orderCount,
                    totalOrders: item.totalOrders,
                    relativeFrequencyPercent: Math.round(
                        item.relativeFrequency * 100
                    ),
                    averageQuantity: item.averageQuantity,
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

    // Holt die Entities Customers und Products aus dem aktuellen SalesOrderService.
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

    /**
     * Resolves a customer's Sales Cloud customer number (BuyerPartyID),
     * falling back to a live Sales Cloud lookup if the customer is not
     * (yet) cached in the local Customers table. Shared by
     * recommendProducts and validateOrderItems.
     */
    const resolveCustomerNumber = async (customerId) => {
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
                ? { customerNumber: salesCloudCustomer.AccountID }
                : customer;
        }

        return customer?.customerNumber || null;
    };

    /**
     * Loads a customer's full historical order line items from SAP Sales
     * Cloud (CustomerOrderCollection + batched CustomerOrderItemCollection
     * reads). Shared by recommendProducts and validateOrderItems.
     *
     * Returns { totalOrders, historicalItems }.
     */
    const loadCustomerOrderHistory = async (customerNumber) => {
        const historicalOrders = getResultRows(await salesCloud.run(
            SELECT.from(CustomerOrderCollection).where({
                BuyerPartyID: customerNumber
            })
        ));

        const orderIDs = [...new Set(historicalOrders
            .map((order) => order.ID)
            .filter((id) => typeof id === "string" && id.length > 0))];

        const totalOrders = orderIDs.length;
        const historicalItems = [];

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

        return { totalOrders, historicalItems };
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
     * Die Action speichert keinen Sales Order.
     */
    this.on("interpretOrderItems", async (req) => {
        const { orderRequest } = req.data;

        if (!orderRequest?.trim()) {
            return req.reject(
                400,
                "The order request must not be empty."
            );
        }

        console.log("Order request received:", orderRequest);

        try {
            const products = await loadSalesCloudProducts();

            if (!products.length) {
                return req.reject(
                    500,
                    "No products are available in the product catalog."
                );
            }

            console.log("Available products:", products);

            const productCatalog = products
                .map(
                    (product) =>
                        `${product.ID} | ${product.productNumber} | ${product.name}`
                )
                .join("\n");

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

            const aiResponse = response.getContent();

            console.log("Raw AI response:", aiResponse);

            const parsedResponse = JSON.parse(aiResponse);

            if (!Array.isArray(parsedResponse.items)) {
                throw new Error(
                    "The AI response does not contain a valid items array."
                );
            }

            if (parsedResponse.items.length === 0) {
                return {
                    success: false,
                    message: "No matching products were identified.",
                    items: []
                };
            }

            const validatedItems = [];
            const clarifications = [];

            for (const item of parsedResponse.items) {

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

            console.log("Validated order items:", validatedItems);
            console.log("Clarifications needed:", clarifications);

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
            console.error("Order item interpretation failed:", error);
            return req.reject(
                500,
                `Order item interpretation failed: ${error.message}`
            );
        }
    });

    /**
     * Reads customer order history from SAP Sales Cloud and returns catalog
     * products ranked by a combined score of RELATIVE and ABSOLUTE order
     * frequency, without creating or changing any orders.
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
            const customerNumber = await resolveCustomerNumber(customerId);

            if (!customerNumber) {
                return req.reject(
                    404,
                    "The selected customer could not be found in the local " +
                        "customer catalog or SAP Sales Cloud."
                );
            }

            let totalOrders;
            let historicalItems;
            try {
                ({ totalOrders, historicalItems } =
                    await loadCustomerOrderHistory(customerNumber));
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

            if (totalOrders === 0) {
                return {
                    success: false,
                    message: "No order history was found for this customer.",
                    recommendations: []
                };
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

            const localProducts = await SELECT.from(Products);
            const localProductsByNumber = new Map(
                localProducts.map((product) => [
                    String(product.productNumber || "").trim().toUpperCase(),
                    product
                ])
            );

            const candidateRecommendations = [];
            for (const aggregate of aggregatesByProductNumber.values()) {

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

                const localProduct = localProductsByNumber.get(
                    aggregate.productNumber
                );

                const productName =
                    localProduct?.name || salesCloudProduct.name;

                const unit =
                    localProduct?.unit || salesCloudProduct.unit || "";

                const unitPrice = Number(
                    localProduct?.price ?? salesCloudProduct.price
                );

                if (!Number.isFinite(unitPrice)) {
                    console.warn(
                        "Skipping recommended product without a catalog price:",
                        aggregate.productNumber
                    );
                    continue;
                }

                const orderCount = aggregate.orderIDs.size;

                const averageQuantity = Math.max(
                    1,
                    Math.round(aggregate.totalQuantity / orderCount)
                );

                candidateRecommendations.push({
                    product_ID: salesCloudProduct.ID,
                    productNumber: salesCloudProduct.productNumber,
                    productName,
                    orderCount,
                    totalQuantity: Math.round(aggregate.totalQuantity),
                    averageQuantity,
                    unitPrice,
                    unit
                });
            }

            if (candidateRecommendations.length === 0) {
                return {
                    success: false,
                    message: aggregatesByProductNumber.size === 0
                        ? "No products could be aggregated from the order history."
                        : "No historical products matched the active Sales Cloud " +
                            "catalog, or all matching products are already in the draft.",
                    recommendations: []
                };
            }

            const rankedRecommendations = rankRecommendationsByFrequency(
                candidateRecommendations,
                totalOrders
            );

            let topRecommendations = rankedRecommendations
                .slice(0, 5)
                .map((item) => ({
                    ...item,
                    reason:
                        `Ordered in ${item.orderCount} of ${item.totalOrders} ` +
                        `orders (${Math.round(item.relativeFrequency * 100)}%), ` +
                        `avg. ${item.averageQuantity} units per order.`
                }));

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
                message: "Product recommendations are ranked by this " +
                    "customer's relative and absolute order frequency.",
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

    /**
     * AI Order Validation.
     * Prüft die aktuell im Fiori-Entwurf enthaltenen Auftragspositionen
     * gegen die SAP-Sales-Cloud-Bestellhistorie desselben Kunden.
     */
    this.on("validateOrderItems", async (req) => {
        const { customerId, items: itemsJson } = req.data;

        if (!customerId) {
            return req.reject(400, "A customer must be selected.");
        }

        let items;
        try {
            items = JSON.parse(itemsJson || "[]");
        } catch {
            return req.reject(
                400,
                "The items parameter must be valid JSON."
            );
        }

        if (!Array.isArray(items) || items.length === 0) {
            return req.reject(
                400,
                "At least one order item must be provided for validation."
            );
        }

        try {
            const customerNumber = await resolveCustomerNumber(customerId);

            if (!customerNumber) {
                return req.reject(
                    404,
                    "The selected customer could not be found in the local " +
                        "customer catalog or SAP Sales Cloud."
                );
            }

            let totalOrders;
            let historicalItems;
            try {
                ({ totalOrders, historicalItems } =
                    await loadCustomerOrderHistory(customerNumber));
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

            if (totalOrders < MIN_ORDERS_FOR_VALIDATION) {
                return {
                    success: true,
                    message:
                        `Insufficient order history (${totalOrders} of ` +
                        `${MIN_ORDERS_FOR_VALIDATION} required historical orders) ` +
                        "to reliably validate this order. No checks were performed.",
                    warnings: []
                };
            }

            let salesCloudProducts;
            try {
                salesCloudProducts = await loadSalesCloudProducts();
            } catch (error) {
                console.error(
                    "Could not load the active SAP Sales Cloud product catalog:",
                    error
                );
                return req.reject(
                    502,
                    `SALES_CLOUD_PRODUCT_CATALOG_${getSalesCloudErrorCode(error)}: ` +
                        getSalesCloudErrorMessage(error)
                );
            }

            const salesCloudProductsById = new Map(
                salesCloudProducts.map((product) => [
                    String(product.ID),
                    product
                ])
            );
            const salesCloudProductsByNumber = new Map(
                salesCloudProducts.map((product) => [
                    String(product.productNumber || "").trim().toUpperCase(),
                    product
                ])
            );

            const productStats = new Map();
            const categoryStats = new Map();

            for (const { salesOrderID, item } of historicalItems) {
                const productNumber = String(item.ProductID || "")
                    .trim()
                    .toUpperCase();
                const quantity = Number(item.Quantity);

                if (!productNumber || !Number.isFinite(quantity) ||
                    quantity <= 0) {
                    continue;
                }

                let productStat = productStats.get(productNumber);
                if (!productStat) {
                    productStat = { orderIDs: new Set(), quantities: [] };
                    productStats.set(productNumber, productStat);
                }
                productStat.orderIDs.add(salesOrderID);
                productStat.quantities.push(quantity);

                const historicalProduct =
                    salesCloudProductsByNumber.get(productNumber);
                const categoryID =
                    historicalProduct?.productCategoryID || "UNCATEGORIZED";

                let categoryStat = categoryStats.get(categoryID);
                if (!categoryStat) {
                    categoryStat = { orderIDs: new Set(), quantities: [] };
                    categoryStats.set(categoryID, categoryStat);
                }
                categoryStat.orderIDs.add(salesOrderID);
                categoryStat.quantities.push(quantity);
            }

            const warnings = [];

            for (const line of items) {
                const position = Number(line.position);
                const quantity = Number(line.quantity);

                if (!Number.isFinite(position) || !line.product_ID ||
                    !Number.isFinite(quantity) || quantity <= 0) {
                    continue;
                }

                const product = salesCloudProductsById.get(
                    String(line.product_ID)
                );

                if (!product) {
                    warnings.push({
                        position,
                        productName: "Unknown product",
                        warningType: "unknown_product",
                        message:
                            `Position ${position}: this product could not be ` +
                            "found in the active SAP Sales Cloud catalog and " +
                            "could not be validated."
                    });
                    continue;
                }

                const productNumber =
                    String(product.productNumber || "").trim().toUpperCase();
                const categoryID = product.productCategoryID || "UNCATEGORIZED";

                const categoryStat = categoryStats.get(categoryID);
                const categoryOrderCount = categoryStat
                    ? categoryStat.orderIDs.size
                    : 0;
                const categoryRelativeFrequency =
                    categoryOrderCount / totalOrders;

                if (categoryOrderCount === 0) {
                    warnings.push({
                        position,
                        productName: product.name,
                        warningType: "rare_category",
                        message:
                            `Position ${position} (${product.name}): belongs to ` +
                            `product category "${categoryID}", which this ` +
                            `customer has never ordered from before (0 of ` +
                            `${totalOrders} historical orders, 0.0% vs. the ` +
                            `${Math.round(RARE_CATEGORY_THRESHOLD * 100)}% ` +
                            "rarity threshold used to flag uncommon categories)."
                    });
                } else if (categoryRelativeFrequency < RARE_CATEGORY_THRESHOLD) {
                    warnings.push({
                        position,
                        productName: product.name,
                        warningType: "rare_category",
                        message:
                            `Position ${position} (${product.name}): belongs to ` +
                            `category "${categoryID}", ordered in only ` +
                            `${categoryOrderCount} of ${totalOrders} historical ` +
                            `orders (${Math.round(categoryRelativeFrequency * 100)}%), ` +
                            `which is below the ` +
                            `${Math.round(RARE_CATEGORY_THRESHOLD * 100)}% threshold ` +
                            "used to flag uncommon categories."
                    });
                }

                let baseline = productStats.get(productNumber);
                let baselineSource = `this exact product (${product.name})`;

                if (!baseline || baseline.quantities.length === 0) {
                    baseline = categoryStats.get(categoryID);
                    baselineSource =
                        `products in category "${categoryID}" (this exact ` +
                        "product has no order history)";
                }

                if (baseline && baseline.quantities.length > 0) {
                    const avgQuantity = average(baseline.quantities);
                    const highThreshold = avgQuantity * QUANTITY_HIGH_FACTOR;
                    const lowThreshold = avgQuantity * QUANTITY_LOW_FACTOR;

                    if (quantity >= highThreshold) {
                        warnings.push({
                            position,
                            productName: product.name,
                            warningType: "unusual_quantity_high",
                            message:
                                `Position ${position} (${product.name}): ordered ` +
                                `quantity ${quantity} is ` +
                                `${(quantity / avgQuantity).toFixed(1)}x the ` +
                                `historical average of ${avgQuantity.toFixed(1)} ` +
                                `units for ${baselineSource} (based on ` +
                                `${baseline.quantities.length} past order ` +
                                "line(s)). Threshold: quantities at or above " +
                                `${QUANTITY_HIGH_FACTOR}x the average ` +
                                `(${highThreshold.toFixed(1)}) are flagged as ` +
                                "unusually high."
                        });
                    } else if (
                        avgQuantity >= MIN_AVERAGE_FOR_LOW_CHECK &&
                        quantity <= lowThreshold
                    ) {
                        warnings.push({
                            position,
                            productName: product.name,
                            warningType: "unusual_quantity_low",
                            message:
                                `Position ${position} (${product.name}): ordered ` +
                                `quantity ${quantity} is only ` +
                                `${(quantity / avgQuantity).toFixed(1)}x the ` +
                                `historical average of ${avgQuantity.toFixed(1)} ` +
                                `units for ${baselineSource} (based on ` +
                                `${baseline.quantities.length} past order ` +
                                "line(s)). Threshold: quantities at or below " +
                                `${QUANTITY_LOW_FACTOR}x the average ` +
                                `(${lowThreshold.toFixed(1)}) are flagged as ` +
                                "unusually low."
                        });
                    }
                }
            }

            warnings.sort((left, right) => left.position - right.position);

            return {
                success: true,
                message: warnings.length > 0
                    ? `${warnings.length} potential issue(s) found across ` +
                        `${items.length} order position(s).`
                    : `No issues found. All ${items.length} position(s) are ` +
                        "consistent with this customer's order history " +
                        `(${totalOrders} orders analyzed).`,
                warnings
            };

        } catch (error) {
            const statusCode = Number(
                error.statusCode || error.status || error.code
            );
            if (statusCode >= 400 && statusCode < 600) {
                return req.reject(statusCode, error.message);
            }
            console.error("Order validation failed:", error);
            return req.reject(
                500,
                `ORDER_VALIDATION_FAILED: ${error.message}`
            );
        }
    });

    /**
     * PICO Intent Router (routeAiCommand).
     *
     * Empfängt einen beliebigen Freitext-Befehl aus dem EINEN PICO-
     * Eingabefeld und entscheidet mittels Sonnet, welche der drei
     * bestehenden Funktionen gemeint ist:
     *
     *   add_items          -> interpretOrderItems
     *   recommend_products -> recommendProducts
     *   validate_order     -> validateOrderItems
     *
     * PICO führt selbst NICHTS aus - er liefert nur die Entscheidung
     * (status + intent) und ggf. einen Text, der dem Nutzer direkt
     * angezeigt wird (Rückfrage, Hinweis auf mehrere Funktionen,
     * freundliche Ablehnung bei unbekannten Anfragen).
     *
     * status:
     *   "ok"                     -> intent ist gesetzt, Controller führt aus
     *   "clarification_required" -> message enthält eine Rückfrage
     *   "multiple_intents"       -> message erklärt, dass nur eine
     *                                Funktion pro Befehl möglich ist
     *   "unknown_intent"         -> message lehnt freundlich ab
     */
    this.on("routeAiCommand", async (req) => {
        const { command } = req.data;

        if (!command?.trim()) {
            return req.reject(400, "The command must not be empty.");
        }

        console.log("PICO command received:", command);

        try {
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
                        content: `You are the intent router for PICO, an AI assistant that helps sales representatives create customer sales orders in a SAP-based application.

PICO can perform exactly three functions:

1. add_items - interpret spoken or typed product names and quantities and add them as order line items to the current order draft.
2. recommend_products - suggest products to add to the order, based on the customer's historical order data.
3. validate_order - check the current order draft's line items against the customer's order history and flag unusual product categories or quantities.

Analyze the user's command and decide which single function is meant.

Rules:

- If the command clearly and unambiguously matches exactly ONE of the three functions, respond with status "ok" and set intent to that function's identifier (add_items, recommend_products, or validate_order). The message field can be a short one-sentence acknowledgement in German.
- If the command explicitly or implicitly asks for TWO OR MORE of the three functions to be performed together (for example "add 5 Nutella and also validate the order"), respond with status "multiple_intents", intent set to an empty string, and a friendly German message explaining that PICO can only execute one function per command and asking the user to submit the requests one at a time.
- If the command could reasonably match more than one function, or its meaning is unclear, respond with status "clarification_required", intent set to an empty string, and a short German clarifying question that helps determine which of the three functions is meant.
- If the command does not relate to any of the three functions at all (for example small talk, unrelated topics, or requests PICO cannot fulfill), respond with status "unknown_intent", intent set to an empty string, and a very friendly German message explaining that PICO cannot help with this, briefly restating the three things PICO can help with.

Always write the "message" field in German, regardless of the language of the input command.

Do not invent order data. Do not decide which specific products or quantities are meant - that happens later in a separate step. Your only job is to decide WHICH of the three functions applies.

Return only valid JSON in exactly this structure. Do not wrap the JSON in Markdown code fences.

{
  "status": "ok" | "clarification_required" | "multiple_intents" | "unknown_intent",
  "intent": "add_items" | "recommend_products" | "validate_order" | "",
  "message": "string"
}`
                    },
                    {
                        role: "user",
                        content: command
                    }
                ]
            });

            const aiResponse = response.getContent();

            console.log("PICO raw routing response:", aiResponse);

            const parsedResponse = JSON.parse(aiResponse);

            if (!PICO_ALLOWED_STATUSES.includes(parsedResponse.status)) {
                throw new Error(
                    `PICO returned an unknown status: ${parsedResponse.status}`
                );
            }

            if (parsedResponse.status === "ok" &&
                !PICO_ALLOWED_INTENTS.includes(parsedResponse.intent)) {
                throw new Error(
                    `PICO returned an unknown intent: ${parsedResponse.intent}`
                );
            }

            return {
                status: parsedResponse.status,
                intent: parsedResponse.status === "ok"
                    ? parsedResponse.intent
                    : "",
                message: parsedResponse.message || ""
            };

        } catch (error) {
            console.error("PICO routing failed:", error);
            return req.reject(
                500,
                `PICO_ROUTING_FAILED: ${error.message}`
            );
        }
    });
});
