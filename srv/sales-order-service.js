import cds from "@sap/cds";
import { OrchestrationClient } from "@sap-ai-sdk/orchestration";

// Waehlt zufaellig eine von mehreren Formulierungen, damit PICO nicht
// jedes Mal exakt denselben Satz sagt.
const pickOne = (...options) =>
    options[Math.floor(Math.random() * options.length)];

// Optionale Resource Group in AI Core (Standard: "default"). Gilt auch fuer
// den Voice-Proxy (srv/voice/realtime-proxy.js).
const AI_CORE_OPTIONS = process.env.AICORE_RESOURCE_GROUP
    ? { resourceGroup: process.env.AICORE_RESOURCE_GROUP }
    : undefined;

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
// Schwellenwerte für generateOrderDraft (PICO: Generate order draft).
//
// Regel (konservativ, damit der Draft nicht überladen wird):
//   - Es werden nur die letzten DRAFT_HISTORY_WINDOW Orders analysiert.
//   - Ein Produkt muss in den letzten DRAFT_RECENT_WINDOW Orders
//     mindestens einmal vorkommen (sonst hat der Kunde es evtl. aufgegeben).
//   - Nachbestellung muss fällig sein (>= 80 % des üblichen Intervalls).
//   - Frequency >= 60 %  -> wird direkt in den Draft übernommen.
//   - Frequency 40-59 %  -> Vorschlag, den der Nutzer bestätigen muss.
// ---------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;
const DRAFT_HISTORY_WINDOW = 10;
const DRAFT_RECENT_WINDOW = 5;
const DRAFT_MIN_ORDERS = 3;
const DRAFT_AUTO_MIN_FREQUENCY = 0.6;
const DRAFT_SUGGEST_MIN_FREQUENCY = 0.4;
const DRAFT_MIN_REORDER_RATIO = 0.8;
const DRAFT_MAX_AUTO_ITEMS = 15;
const DRAFT_MAX_SUGGESTIONS = 8;
// Mögliche Datumsfelder der Sales-Cloud-Order (bitte im Log prüfen).
const ORDER_DATE_FIELDS = ["CreationDateTime", "DateTime"];

// ---------------------------------------------------------------------
// PICO Intent Router (routeAiCommand).
//
// select_customer wurde als vierte Funktion ergänzt: PICO kann jetzt
// auch den Kunden per Freitext-/Sprachbefehl auswählen.
// generate_order_draft ist die fünfte Funktion: Auftragsentwurf aus
// der Kundenhistorie.
// ---------------------------------------------------------------------
const PICO_ALLOWED_STATUSES = [
    "ok",
    "clarification_required",
    "multiple_intents",
    "unknown_intent"
];
const PICO_ALLOWED_INTENTS = [
    "select_customer",
    "generate_order_draft",
    "add_items",
    "recommend_products",
    "validate_order",
    "copy_last_order"
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

// Einfache Pluralbildung fuer die Chat-Texte von PICO ("1 item", "3 items").
function countOf(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

function average(numbers) {
    return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

/**
 * Wandelt ein Sales-Cloud-Datum (ISO-String, /Date(...)/ oder Date)
 * in einen Timestamp (ms) um. Gibt null zurück, wenn nicht lesbar.
 */
function parseSalesCloudDate(value) {
    if (!value) {
        return null;
    }
    if (value instanceof Date) {
        return value.getTime();
    }
    const text = String(value);
    const odataMatch = /\/Date\((-?\d+)/.exec(text);
    if (odataMatch) {
        return Number(odataMatch[1]);
    }
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
}

function getOrderTimestamp(order) {
    for (const field of ORDER_DATE_FIELDS) {
        const timestamp = parseSalesCloudDate(order?.[field]);
        if (timestamp !== null) {
            return timestamp;
        }
    }
    return null;
}

// Neueste Order zuerst; Fallback auf die (numerische) Order-ID.
function compareOrdersNewestFirst(left, right) {
    if (left.timestamp !== null && right.timestamp !== null &&
        left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
    }
    const leftID = Number(left.id);
    const rightID = Number(right.id);
    if (Number.isFinite(leftID) && Number.isFinite(rightID)) {
        return rightID - leftID;
    }
    return String(right.id).localeCompare(String(left.id));
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
    }, AI_CORE_OPTIONS);

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
        if (!["ID","productNumber", "name", "productCategoryID"].includes(property)) {
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
     * Lädt die aktiven Sales-Cloud-Kunden (CorporateAccountCollection).
     * Zentral ausgelagert, damit sowohl der normale OData-READ-Handler
     * für /Customers als auch die neue PICO-Funktion selectCustomer
     * dieselbe Quelle verwenden.
     */
    const loadSalesCloudCustomers = async () => {
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
    };

    /**
     * Resolves a customer's Sales Cloud customer number (BuyerPartyID),
     * falling back to a live Sales Cloud lookup if the customer is not
     * (yet) cached in the local Customers table. Shared by
     * recommendProducts, validateOrderItems and generateOrderDraft.
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
     * reads). Shared by recommendProducts, validateOrderItems and
     * generateOrderDraft.
     *
     * Returns { totalOrders, historicalItems, historicalOrders }.
     * historicalOrders enthält die Order-Köpfe (inkl. Datumsfelder) und
     * wird für das Reorder-Timing in generateOrderDraft benötigt.
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

        return { totalOrders, historicalItems, historicalOrders };
    };

    this.on("READ", Customers, async () => {
        return loadSalesCloudCustomers();
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
        const { orderRequest, currentItems: currentItemsJson } = req.data;

        if (!orderRequest?.trim()) {
            return req.reject(
                400,
                "The order request must not be empty."
            );
        }

        let currentItems = [];
        try {
            const parsed = JSON.parse(currentItemsJson || "[]");
            if (Array.isArray(parsed)) {
                currentItems = parsed.filter(
                    (line) => Number.isFinite(Number(line.position)) &&
                        line.product_ID
                );
            }
        } catch {
            return req.reject(
                400,
                "The current items must be valid JSON."
            );
        }
        const currentLineByPosition = new Map(
            currentItems.map((line) => [Number(line.position), line])
        );
        const currentOrderText = currentItems.length > 0
            ? currentItems
                .map((line) =>
                    `position ${line.position} | ${line.productName} | ` +
                    `quantity ${line.quantity}`)
                .join("\n")
            : "(the order draft is currently empty)";

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
            }, AI_CORE_OPTIONS);

            const response = await client.chatCompletion({
                messages: [
                    {
                        role: "system",
                        content: `You extract order item changes from a sales representative's input.
The representative can ADD new items, EDIT existing items (change the product
and/or the quantity) and REMOVE existing items.

You must match every requested product against the following product catalog:

${productCatalog}

The order draft currently contains these lines:

${currentOrderText}

For every requested product, decide for yourself whether you are confident
which catalog product is meant, or whether the request is ambiguous.

A request is ambiguous if the wording could reasonably match more than one
product in the catalog (for example, a brand name without a specific variant).

Rules:

- If you are confident which single product is meant, return it as a resolved item.
- If you are not confident, do not guess. Instead, return clarification_required
  and list every catalog product that could reasonably match, as suggestions.
- If a request is broad or generic and could match many catalog products
  (for example a category name like "chocolates" or "snacks" rather than
  a specific product), do not list every possible match. Select at most
  the 5 most relevant and clearly distinct products as suggestions.
- When choosing which products to suggest, double-check that each
  suggested productId exactly matches the productName from the same
  catalog line. Never pair a productId from one line with a productName
  from a different line.
- Every item has an "action": "add" (new line), "update" (change an existing
  line) or "remove" (delete an existing line). Use "add" unless the user
  clearly refers to something already in the order draft (for example
  "change", "make it", "instead of", "replace", "remove", "delete", "drop").
- For "update" and "remove", set "position" to the position of the existing
  line from the order draft above. Refer to existing lines only by the
  positions listed above.
- For "update", set "productId"/"productName" only if the product itself
  changes (use the same clarification rules as above if the new product is
  ambiguous); otherwise omit them. Set "quantity" only if the quantity
  changes; otherwise omit it.
- If an edit or removal cannot be matched to exactly one existing line, return
  status "not_applicable" with a short "message" instead of guessing.
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
      "action": "add",
      "productId": "ID from catalog",
      "productName": "exact name from catalog",
      "quantity": 1
    },
    {
      "status": "resolved",
      "action": "update",
      "position": 10,
      "productId": "ID from catalog (only if the product changes)",
      "productName": "exact name from catalog (only if the product changes)",
      "quantity": 5
    },
    {
      "status": "resolved",
      "action": "remove",
      "position": 20
    },
    {
      "status": "clarification_required",
      "action": "add or update",
      "position": 10,
      "question": "Friendly, conversational question in English, e.g. 'I found a few Nutella products - which one did you mean?'",
      "quantity": 1,
      "suggestions": [
        {
          "productId": "ID from catalog",
          "productName": "exact name from catalog"
        }
      ]
    },
    {
      "status": "not_applicable",
      "message": "Short explanation"
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
                    message: "Hmm, I couldn't find a matching product for that. " +
                        "Could you tell me again what you'd like to change?",
                    items: []
                };
            }

            const validatedItems = [];
            const clarifications = [];
            const notes = [];

            for (const item of parsedResponse.items) {

                if (item.status === "not_applicable") {
                    notes.push(
                        String(item.message || "A change could not be applied.")
                    );
                    continue;
                }

                if (item.status === "resolved") {

                    const action = ["update", "remove"].includes(item.action)
                        ? item.action
                        : "add";
                    const position = Number(item.position);
                    const line = action === "add"
                        ? null
                        : currentLineByPosition.get(position);

                    if (action !== "add" && !line) {
                        notes.push(
                            `I couldn't find position ${item.position} in ` +
                                "your order draft."
                        );
                        continue;
                    }

                    if (action === "remove") {
                        validatedItems.push({
                            action,
                            position,
                            product_ID: line.product_ID,
                            productName: line.productName,
                            quantity: Number(line.quantity) || 0,
                            confidence: 1,
                            message: ""
                        });
                        continue;
                    }

                    // add: Produkt aus dem Katalog. update: neues Produkt,
                    // falls angegeben, sonst das Produkt der bestehenden Zeile.
                    const productId = action === "update" && !item.productId
                        ? line.product_ID
                        : item.productId;
                    const product = products.find(
                        (candidate) => candidate.ID === productId
                    );

                    if (!product) {
                        throw new Error(
                            `Unknown product returned by AI: ${item.productName}`
                        );
                    }

                    const quantity =
                        action === "update" &&
                        (item.quantity === undefined || item.quantity === null)
                            ? Number(line.quantity)
                            : Number(item.quantity);
                    const unitPrice = Number(product.price);

                    if (!Number.isInteger(quantity) || quantity <= 0) {
                        throw new Error(
                            `Invalid quantity for product: ${product.name}`
                        );
                    }

                    validatedItems.push({
                        action,
                        position: action === "update" ? position : null,
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

                   const validatedSuggestions = (item.suggestions || [])
    .map((suggestion) => {
        const product = products.find(
            (candidate) => candidate.ID === suggestion.productId
        );

        if (!product) {
            // Statt die ganze Anfrage abzubrechen: nur diesen einen
            // fehlerhaften Vorschlag überspringen und loggen.
            console.warn(
                "Skipping hallucinated suggestion from AI:",
                suggestion.productName,
                suggestion.productId
            );
            return null;
        }

        return {
            productId: product.ID,
            productName: product.name
        };
    })
    .filter(Boolean);

if (validatedSuggestions.length === 0) {
    throw new Error(
        `No valid suggestions remained for question: "${item.question}"`
    );
}

                    const clarificationAction =
                        item.action === "update" ? "update" : "add";
                    const clarificationPosition = Number(item.position);
                    if (clarificationAction === "update" &&
                        !currentLineByPosition.has(clarificationPosition)) {
                        notes.push(
                            `I couldn't find position ${item.position} in ` +
                                "your order draft."
                        );
                        continue;
                    }

                    clarifications.push({
                        question: item.question,
                        // Bei update bleibt die Menge ohne Angabe unveraendert.
                        quantity: Number(item.quantity) ||
                            (clarificationAction === "update" ? null : 1),
                        action: clarificationAction,
                        position: clarificationAction === "update"
                            ? clarificationPosition
                            : null,
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
                message = `Done, I've applied ` +
                    `${countOf(validatedItems.length, "change")}. ` +
                    `For ${countOf(clarifications.length, "product")} I'm ` +
                    "not sure what you mean, so please pick the right " +
                    `${clarifications.length === 1 ? "one" : "ones"} below.`;
            } else if (hasClarifications) {
                message = pickOne(
                    "I found a few products that could fit, so I need you to " +
                        "decide. ",
                    "I'm not sure which product you mean. "
                ) + `Please pick the right ${clarifications.length === 1 ? "one" : "ones"} below.`;
            } else {
                message = pickOne(
                    `Done, I've applied ${countOf(validatedItems.length, "change")} ` +
                        "to your order draft.",
                    `All set - ${countOf(validatedItems.length, "change")} ` +
                        "made in your order draft."
                );
            }

            if (notes.length > 0) {
                if (validatedItems.length === 0 && !hasClarifications) {
                    return {
                        success: false,
                        message: notes.join(" "),
                        items: [],
                        clarifications: []
                    };
                }
                message += " " + notes.join(" ");
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
                    message: "I couldn't find any past orders for this customer, " +
                        "so I have nothing to base suggestions on yet.",
                    recommendations: []
                };
            }

            if (historicalItems.length === 0) {
                return {
                    success: false,
                    message: "This customer's past orders don't contain any " +
                        "items I could learn from.",
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
                        ? "I couldn't pick out any products from the order history."
                        : "I have no new suggestions: the products this " +
                            "customer used to order are either no longer " +
                            "available or already in your draft.",
                    recommendations: []
                };
            }

            const rankedRecommendations = rankRecommendationsByFrequency(
                candidateRecommendations,
                totalOrders
            );

            // Gleiche Struktur wie beim Order Draft: Menge, Gesamtpreis und
            // drei kurze, deterministische Begruendungen ("Why?").
            const topRecommendations = rankedRecommendations
                .slice(0, 5)
                .map((item) => {
                    const pctValue = Math.round(item.relativeFrequency * 100);
                    return {
                        ...item,
                        quantity: item.averageQuantity,
                        totalPrice: Number(
                            (item.unitPrice * item.averageQuantity).toFixed(2)
                        ),
                        frequencyPercent: pctValue,
                        reason:
                            `This customer ordered it in ${item.orderCount} of ` +
                            `${item.totalOrders} orders (${pctValue}%).`,
                        reasonProduct:
                            `This customer ordered it in ${item.orderCount} of ` +
                            `${item.totalOrders} orders (${pctValue}%).`,
                        reasonQuantity:
                            `They usually take about ${item.averageQuantity} ` +
                            `${item.unit}`.trim() + " per order.",
                        reasonDecision:
                            "It's one of their most frequently ordered " +
                            "products, so I'm suggesting it. Your call!"
                    };
                });

            return {
                success: true,
                message: topRecommendations.length === 1
                    ? pickOne(
                        `I found one product this customer often orders ` +
                            `(based on ${totalOrders} past orders). Have a ` +
                            "look below and add it if you like.",
                        `Looking at ${totalOrders} past orders, one product ` +
                            "stands out. It's listed below - add it if it fits."
                    )
                    : pickOne(
                        `I found ${topRecommendations.length} products this ` +
                            `customer keeps coming back to (based on ` +
                            `${totalOrders} past orders). There are several, ` +
                            "so please pick the ones you'd like me to add below.",
                        `Looking at ${totalOrders} past orders, ` +
                            `${topRecommendations.length} products stand out. ` +
                            "They're listed below - choose the ones you want " +
                            "in the order.",
                        `Here are ${topRecommendations.length} ideas based ` +
                            `on ${totalOrders} past orders. Please choose below ` +
                            "which of them should go into the order."
                    ),
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
                        `I can't check this order yet: this customer has only ` +
                        `${totalOrders} past ${totalOrders === 1 ? "order" : "orders"} ` +
                        `and I need at least ${MIN_ORDERS_FOR_VALIDATION} to compare with.`,
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
                        message: "I couldn't find this product in the catalog, " +
                            "so I wasn't able to check it."
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
                            `This customer has never ordered from category ` +
                            `"${categoryID}" before. Is that intended?`
                    });
                } else if (categoryRelativeFrequency < RARE_CATEGORY_THRESHOLD) {
                    warnings.push({
                        position,
                        productName: product.name,
                        warningType: "rare_category",
                        message:
                            `This customer rarely orders from category ` +
                            `"${categoryID}" (only ${categoryOrderCount} of ` +
                            `${totalOrders} orders). Is that intended?`
                    });
                }

                let baseline = productStats.get(productNumber);
                let baselineSource = "this product";

                if (!baseline || baseline.quantities.length === 0) {
                    baseline = categoryStats.get(categoryID);
                    baselineSource = `category "${categoryID}"`;
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
                                `${quantity} looks quite high: that's ` +
                                `${(quantity / avgQuantity).toFixed(1)}x what ` +
                                `this customer usually orders ` +
                                `(about ${avgQuantity.toFixed(1)} for ` +
                                `${baselineSource}). Is that right?`
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
                                `${quantity} looks quite low: that's only ` +
                                `${(quantity / avgQuantity).toFixed(1)}x what ` +
                                `this customer usually orders ` +
                                `(about ${avgQuantity.toFixed(1)} for ` +
                                `${baselineSource}). Is that right?`
                        });
                    }
                }
            }

            warnings.sort((left, right) => left.position - right.position);

            return {
                success: true,
                message: warnings.length > 0
                    ? `I took a look and found ${countOf(warnings.length, "thing")} ` +
                        "worth a second look. Please go through " +
                        `${warnings.length === 1 ? "it" : "them"} below: ` +
                        "you can ignore a hint if it's fine, or change the " +
                        "order yourself."
                    : pickOne(
                        "All good! Your order looks just like what this " +
                            `customer usually orders (I compared it with ` +
                            `${totalOrders} past orders).`,
                        "Everything looks fine to me - it matches what this " +
                            `customer usually orders (checked against ` +
                            `${totalOrders} past orders).`
                    ),
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
     * PICO: Select Customer.
     *
     * Empfängt einen Freitext-/Sprachbefehl und ermittelt, welcher Kunde
     * gemeint ist, basierend auf Name und/oder Kundennummer. Sonnet
     * erhält dafür den vollständigen aktiven Sales-Cloud-Kundenkatalog
     * als Kontext (analog zum Produktkatalog bei interpretOrderItems)
     * und darf ausschließlich Kunden aus diesem Katalog zurückgeben.
     *
     * status "resolved": genau ein Kunde wurde eindeutig erkannt.
     * status "clarification_required": entweder mehrere passende Kunden
     *   (Rückfrage + anklickbare Vorschläge) oder gar kein Treffer
     *   (Rückfrage, aber leere Vorschlagsliste).
     *
     * Diese Action wählt selbst keinen Kunden aus der UI aus - das
     * übernimmt der Controller (_applySelectedCustomer), sobald das
     * Ergebnis vorliegt bzw. der Nutzer eine Rückfrage beantwortet hat.
     */
    this.on("selectCustomer", async (req) => {
        const { command } = req.data;

        if (!command?.trim()) {
            return req.reject(400, "The command must not be empty.");
        }

        console.log("Customer selection command received:", command);

        try {
            const customers = await loadSalesCloudCustomers();

            if (!customers.length) {
                return req.reject(
                    500,
                    "No customers are available in the customer catalog."
                );
            }

            const customerCatalog = customers
                .map(
                    (customer) =>
                        `${customer.ID} | ${customer.customerNumber} | ${customer.name}`
                )
                .join("\n");

            const client = new OrchestrationClient({
                promptTemplating: {
                    model: {
                        name: "anthropic--claude-4.6-sonnet"
                    }
                }
            }, AI_CORE_OPTIONS);

            const response = await client.chatCompletion({
                messages: [
                    {
                        role: "system",
                        content: `You identify which customer a sales representative wants to select for a sales order, based on a spoken or typed command that may reference the customer's name and/or customer number.

You must match the command against the following customer catalog:

${customerCatalog}

Rules:

- If you are confident which single customer is meant (by name, by customer number, or both), return status "resolved" with that customer's exact ID, customer number, and name from the catalog.
- If the command could reasonably match more than one customer (for example, a partial or generic name), do not guess. Return status "clarification_required", a short, friendly, conversational clarifying question in English written as PICO speaking to the user (for example "I found a few customers that fit - which one did you mean?"), and list every catalog customer that could reasonably match as suggestions.
- If the command does not match any customer in the catalog at all, return status "clarification_required", a short, friendly, conversational question in English (as PICO speaking to the user) asking the user to repeat or clarify the customer name or number, and an empty suggestions list.
- Never invent a customer ID, customer number, or name that is not in the catalog.
- Base your decision only on the provided catalog.
- Do not create, save, or submit a sales order. Your only job is to identify the customer.
- Return only valid JSON. Do not wrap the JSON in Markdown code fences.

Return exactly this structure:

{
  "status": "resolved" | "clarification_required",
  "customerId": "ID from catalog, or empty string if not resolved",
  "customerNumber": "customer number from catalog, or empty string if not resolved",
  "customerName": "exact name from catalog, or empty string if not resolved",
  "question": "string (only used when status is clarification_required)",
  "suggestions": [
    {
      "customerId": "ID from catalog",
      "customerNumber": "customer number from catalog",
      "customerName": "exact name from catalog"
    }
  ]
}`
                    },
                    {
                        role: "user",
                        content: command
                    }
                ]
            });

            const aiResponse = response.getContent();

            console.log("Raw customer selection AI response:", aiResponse);

            const parsedResponse = JSON.parse(aiResponse);

            if (!["resolved", "clarification_required"].includes(
                parsedResponse.status
            )) {
                throw new Error(
                    `Unknown status returned by AI: ${parsedResponse.status}`
                );
            }

            if (parsedResponse.status === "resolved") {

                const customer = customers.find(
                    (candidate) => candidate.ID === parsedResponse.customerId
                );

                if (!customer) {
                    throw new Error(
                        `Unknown customer returned by AI: ${parsedResponse.customerName}`
                    );
                }

                return {
                    status: "resolved",
                    customerId: customer.ID,
                    customerNumber: customer.customerNumber,
                    customerName: customer.name,
                    question: "",
                    suggestions: []
                };
            }

            const validatedSuggestions = (parsedResponse.suggestions || [])
                .map((suggestion) => {
                    const customer = customers.find(
                        (candidate) => candidate.ID === suggestion.customerId
                    );

                    if (!customer) {
                        throw new Error(
                            `Unknown suggested customer returned by AI: ${suggestion.customerName}`
                        );
                    }

                    return {
                        customerId: customer.ID,
                        customerNumber: customer.customerNumber,
                        customerName: customer.name
                    };
                });

            return {
                status: "clarification_required",
                customerId: "",
                customerNumber: "",
                customerName: "",
                question:
                    parsedResponse.question ||
                    "Sorry, I am not sure which customer you mean. Could you tell me again?",
                suggestions: validatedSuggestions
            };

        } catch (error) {
            console.error("Customer selection failed:", error);
            return req.reject(
                500,
                `Customer selection failed: ${error.message}`
            );
        }
    });

    /**
     * PICO: Generate order draft.
     *
     * Analysiert die letzten DRAFT_HISTORY_WINDOW Orders des Kunden und
     * teilt Produkte in zwei Gruppen:
     *   autoItems   -> Frequency >= 60 %, in den letzten 5 Orders dabei,
     *                  Nachbestellung fällig (>= 80 % des Intervalls)
     *   suggestions -> Frequency 40-59 %, sonst gleiche Bedingungen
     *                  (oder Fälligkeit nicht prüfbar) -> Nutzer bestätigt
     * Menge = historischer Durchschnitt. Jede Entscheidung bekommt eine
     * deterministische Begründung (kein LLM). Die Action ändert nichts
     * in der Sales Cloud.
     */
    this.on("generateOrderDraft", async (req) => {
        const { customerId, excludedProductIDs = "[]" } = req.data;

        if (!customerId) {
            return req.reject(400, "A customer must be selected.");
        }

        let excludedList;
        try {
            excludedList = JSON.parse(excludedProductIDs || "[]");
        } catch {
            return req.reject(
                400,
                "The excluded product ID list must be valid JSON."
            );
        }
        if (!Array.isArray(excludedList) ||
            excludedList.some((id) => typeof id !== "string")) {
            return req.reject(
                400,
                "The excluded product IDs must be a JSON array of strings."
            );
        }
        const excludedSet = new Set(excludedList);

        const emptyResult = (message, analyzedOrders = 0) => ({
            success: false,
            message,
            analyzedOrders,
            autoItems: [],
            suggestions: []
        });

        try {
            const customerNumber = await resolveCustomerNumber(customerId);
            if (!customerNumber) {
                return req.reject(
                    404,
                    "The selected customer could not be found in the local " +
                        "customer catalog or SAP Sales Cloud."
                );
            }

            let historicalOrders;
            let historicalItems;
            try {
                ({ historicalOrders, historicalItems } =
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

            // Orders deduplizieren, sortieren, Analysefenster bilden.
            const seenOrderIDs = new Set();
            const orders = [];
            for (const order of historicalOrders) {
                if (typeof order.ID !== "string" || !order.ID ||
                    seenOrderIDs.has(order.ID)) {
                    continue;
                }
                seenOrderIDs.add(order.ID);
                orders.push({
                    id: order.ID,
                    timestamp: getOrderTimestamp(order)
                });
            }
            orders.sort(compareOrdersNewestFirst);

            const windowOrders = orders.slice(0, DRAFT_HISTORY_WINDOW);
            const analyzedOrders = windowOrders.length;

            if (analyzedOrders < DRAFT_MIN_ORDERS) {
                return emptyResult(
                    `I can't build a reliable draft yet: this customer has only ` +
                        `${analyzedOrders} past ${analyzedOrders === 1 ? "order" : "orders"} ` +
                        `and I need at least ${DRAFT_MIN_ORDERS}.`,
                    analyzedOrders
                );
            }

            const windowIDs = new Set(windowOrders.map((o) => o.id));
            const recentIDs = new Set(
                windowOrders.slice(0, DRAFT_RECENT_WINDOW).map((o) => o.id)
            );
            const timestampByOrder = new Map(
                windowOrders.map((o) => [o.id, o.timestamp])
            );

            // Aggregation pro Produkt: Menge je Order (mehrere Zeilen
            // desselben Produkts in einer Order werden summiert).
            const aggregates = new Map();
            for (const { salesOrderID, item } of historicalItems) {
                if (!windowIDs.has(salesOrderID)) {
                    continue;
                }
                const productNumber = String(item.ProductID || "")
                    .trim()
                    .toUpperCase();
                const quantity = Number(item.Quantity);
                if (!productNumber || !Number.isFinite(quantity) ||
                    quantity <= 0) {
                    continue;
                }
                let aggregate = aggregates.get(productNumber);
                if (!aggregate) {
                    aggregate = {
                        productNumber,
                        quantityByOrder: new Map()
                    };
                    aggregates.set(productNumber, aggregate);
                }
                aggregate.quantityByOrder.set(
                    salesOrderID,
                    (aggregate.quantityByOrder.get(salesOrderID) || 0) +
                        quantity
                );
            }

            let catalog;
            try {
                catalog = await loadSalesCloudProducts();
            } catch (error) {
                console.error(
                    "Could not load the active SAP Sales Cloud catalog:",
                    error
                );
                return req.reject(
                    502,
                    `SALES_CLOUD_PRODUCT_CATALOG_${getSalesCloudErrorCode(error)}: ` +
                        getSalesCloudErrorMessage(error)
                );
            }
            const catalogByNumber = new Map(
                catalog.map((product) => [
                    String(product.productNumber || "").trim().toUpperCase(),
                    product
                ])
            );

            const autoItems = [];
            const suggestions = [];
            let skipped = 0;
            const now = Date.now();
            const pct = (value) => Math.round(value * 100);

            for (const aggregate of aggregates.values()) {
                const product = catalogByNumber.get(aggregate.productNumber);
                if (!product || excludedSet.has(String(product.ID))) {
                    continue;
                }
                const unitPrice = Number(product.price);
                if (!Number.isFinite(unitPrice)) {
                    continue;
                }

                const orderIDs = [...aggregate.quantityByOrder.keys()];
                const orderCount = orderIDs.length;
                const frequency = orderCount / analyzedOrders;
                const purchasedRecently =
                    orderIDs.some((id) => recentIDs.has(id));

                // Produkte, die die strengen Kriterien nicht erfuellen,
                // werden nicht verworfen, sondern als schwaecherer
                // Vorschlag (Fallback) angeboten.
                let fallbackReason = "";
                if (frequency < DRAFT_SUGGEST_MIN_FREQUENCY ||
                    !purchasedRecently) {
                    fallbackReason =
                        "They order it rarely or not recently, so I'm only " +
                        "suggesting it.";
                }

                // Reorder-Timing aus den Bestelldaten.
                const purchaseTimes = orderIDs
                    .map((id) => timestampByOrder.get(id))
                    .filter((t) => t !== null && t !== undefined)
                    .sort((a, b) => a - b);

                let reorderKnown = false;
                let avgIntervalDays = 0;
                let daysSinceLast = 0;
                let reorderRatio = 0;

                if (purchaseTimes.length >= 2) {
                    const gaps = [];
                    for (let i = 1; i < purchaseTimes.length; i += 1) {
                        gaps.push(
                            (purchaseTimes[i] - purchaseTimes[i - 1]) / DAY_MS
                        );
                    }
                    avgIntervalDays = Math.max(average(gaps), 1);
                    daysSinceLast = Math.max(
                        (now - purchaseTimes[purchaseTimes.length - 1]) /
                            DAY_MS,
                        0
                    );
                    reorderRatio = daysSinceLast / avgIntervalDays;
                    reorderKnown = true;
                }

                let decision;
                if (fallbackReason) {
                    decision = "suggested";
                } else if (reorderKnown) {
                    if (reorderRatio < DRAFT_MIN_REORDER_RATIO) {
                        fallbackReason =
                            "They order it regularly, but it's probably " +
                            "not due again yet, so I'm only suggesting it.";
                        decision = "suggested";
                    } else {
                        decision = frequency >= DRAFT_AUTO_MIN_FREQUENCY
                            ? "auto"
                            : "suggested";
                    }
                } else {
                    // Fälligkeit nicht prüfbar -> nie automatisch hinzufügen.
                    decision = "suggested";
                }

                const quantities = [...aggregate.quantityByOrder.values()];
                const averageQuantity = average(quantities);
                const quantity = Math.max(1, Math.round(averageQuantity));
                const unit = product.unit || "";

                const reasonProduct =
                    `This customer ordered it in ${orderCount} of ` +
                    `${analyzedOrders} orders (${pct(frequency)}%)` +
                    (reorderKnown
                        ? `, most recently ${Math.round(daysSinceLast)} days ` +
                          `ago (usually every ${Math.round(avgIntervalDays)} days).`
                        : ".");

                const reasonQuantity =
                    `They usually take about ${averageQuantity.toFixed(1)}` +
                    (unit ? ` ${unit}` : "") +
                    `, so I went with ${quantity}.`;

                let reasonDecision;
                if (decision === "auto") {
                    reasonDecision =
                        "They order it often and it's due again, so I added it.";
                } else if (fallbackReason) {
                    reasonDecision = fallbackReason;
                } else if (reorderKnown) {
                    reasonDecision =
                        "I'm not completely sure about this one, so I'm " +
                        "only suggesting it.";
                } else {
                    reasonDecision =
                        "I can't tell when they'd reorder it, so I'm only " +
                        "suggesting it.";
                }

                const entry = {
                    product_ID: product.ID,
                    productNumber: product.productNumber,
                    productName: product.name,
                    unit,
                    quantity,
                    unitPrice,
                    totalPrice: Number((unitPrice * quantity).toFixed(2)),
                    decision,
                    orderCount,
                    totalOrders: analyzedOrders,
                    frequencyPercent: pct(frequency),
                    reasonProduct,
                    reasonQuantity,
                    reasonDecision,
                    _frequency: frequency,
                    _fallback: Boolean(fallbackReason)
                };
                (decision === "auto" ? autoItems : suggestions).push(entry);
            }

            // Regulaere Vorschlaege zuerst, Fallback-Vorschlaege danach.
            const byFrequency = (a, b) =>
                Number(a._fallback) - Number(b._fallback) ||
                b._frequency - a._frequency || b.orderCount - a.orderCount;
            const strip = ({ _frequency, _fallback, ...rest }) => rest;

            const finalAuto = autoItems
                .sort(byFrequency)
                .slice(0, DRAFT_MAX_AUTO_ITEMS)
                .map(strip);
            const finalSuggestions = suggestions
                .sort(byFrequency)
                .slice(0, DRAFT_MAX_SUGGESTIONS)
                .map(strip);

            console.log(
                `Order draft: ${finalAuto.length} auto, ` +
                    `${finalSuggestions.length} suggested, ${skipped} skipped ` +
                    `(${analyzedOrders} orders analyzed).`
            );

            if (finalAuto.length === 0 && finalSuggestions.length === 0) {
                return emptyResult(
                    "I don't have anything to put into a draft right now. " +
                        `Looking at the last ${analyzedOrders} orders, nothing ` +
                        "is due for a reorder yet, or it's already in your draft.",
                    analyzedOrders
                );
            }

            return {
                success: true,
                message: finalAuto.length > 0 && finalSuggestions.length > 0
                    ? `I've put ${countOf(finalAuto.length, "item")} into your ` +
                        "draft that this customer is due to reorder " +
                        `(based on the last ${analyzedOrders} orders). I'm ` +
                        `not sure about ${finalSuggestions.length === 1 ? "one more" : finalSuggestions.length + " more"}, ` +
                        "so please check the suggestions below and confirm " +
                        "the ones you want."
                    : finalAuto.length > 0
                        ? pickOne(
                            `I've added ${countOf(finalAuto.length, "item")} to ` +
                                "your draft that this customer is due to " +
                                `reorder (based on the last ${analyzedOrders} ` +
                                "orders). Have a look and change anything you like.",
                            `Your draft is ready: ${countOf(finalAuto.length, "item")} ` +
                                "that this customer is due to reorder " +
                                `(from the last ${analyzedOrders} orders). Adjust ` +
                                "it as you see fit."
                        )
                        : `I'm not sure what is due for a reorder yet, so I ` +
                            `collected ${finalSuggestions.length === 1 ? "one suggestion" : finalSuggestions.length + " suggestions"} ` +
                            `from the last ${analyzedOrders} orders. Please ` +
                            "check below and confirm what I should add.",
                analyzedOrders,
                autoItems: finalAuto,
                suggestions: finalSuggestions
            };

        } catch (error) {
            const statusCode = Number(
                error.statusCode || error.status || error.code
            );
            if (statusCode >= 400 && statusCode < 600) {
                return req.reject(statusCode, error.message);
            }
            console.error("Order draft generation failed:", error);
            return req.reject(
                500,
                `ORDER_DRAFT_FAILED: ${error.message}`
            );
        }
    });

    /**
     * PICO: Copy last order.
     *
     * Ermittelt die neueste Order des Kunden (Filter BuyerPartyID, neueste
     * per DateTime, Fallback Order-ID) und liest deren Positionen ueber
     * ParentObjectID = ObjectID der Order. Die Positionen werden gegen den
     * aktiven Produktkatalog geprueft und mit aktuellem Preis geliefert.
     * Die Action aendert nichts in der Sales Cloud.
     */
    this.on("copyLastOrder", async (req) => {
        const { customerId } = req.data;

        if (!customerId) {
            return req.reject(400, "A customer must be selected.");
        }

        const emptyResult = (message) => ({
            success: false,
            message,
            orderNumber: "",
            orderDate: "",
            items: []
        });

        try {
            const customerNumber = await resolveCustomerNumber(customerId);
            if (!customerNumber) {
                return req.reject(
                    404,
                    "The selected customer could not be found in the local " +
                        "customer catalog or SAP Sales Cloud."
                );
            }

            let lastOrder;
            let itemRows;
            try {
                const orderRows = getResultRows(await salesCloud.run(
                    SELECT.from(CustomerOrderCollection)
                        .columns("ObjectID", "ID", "DateTime")
                        .where({ BuyerPartyID: customerNumber })
                ));

                const orders = orderRows
                    .filter((order) => order.ObjectID && order.ID)
                    .map((order) => ({
                        id: order.ID,
                        objectID: order.ObjectID,
                        timestamp: getOrderTimestamp(order)
                    }))
                    .sort(compareOrdersNewestFirst);

                lastOrder = orders[0];
                if (!lastOrder) {
                    return emptyResult(
                        "I couldn't find any previous order for this customer."
                    );
                }

                itemRows = getResultRows(await salesCloud.run(
                    SELECT.from(CustomerOrderItemCollection)
                        .where({ ParentObjectID: lastOrder.objectID })
                ));
            } catch (error) {
                console.error(
                    "Could not read the last order from SAP Sales Cloud:",
                    error
                );
                return req.reject(
                    502,
                    `SALES_CLOUD_LAST_ORDER_${getSalesCloudErrorCode(error)}: ` +
                        getSalesCloudErrorMessage(error)
                );
            }

            let catalog;
            try {
                catalog = await loadSalesCloudProducts();
            } catch (error) {
                console.error(
                    "Could not load the active SAP Sales Cloud catalog:",
                    error
                );
                return req.reject(
                    502,
                    `SALES_CLOUD_PRODUCT_CATALOG_${getSalesCloudErrorCode(error)}: ` +
                        getSalesCloudErrorMessage(error)
                );
            }
            const catalogByNumber = new Map(
                catalog.map((product) => [
                    String(product.productNumber || "").trim().toUpperCase(),
                    product
                ])
            );

            // Positionen in Original-Reihenfolge; gleiche Produkte werden
            // summiert, nicht mehr aktive Produkte uebersprungen.
            itemRows.sort((a, b) =>
                (Number(a.ID) || 0) - (Number(b.ID) || 0));
            const itemsByProduct = new Map();
            let skipped = 0;
            for (const row of itemRows) {
                const productNumber = String(row.ProductID || "")
                    .trim()
                    .toUpperCase();
                const quantity = Math.round(Number(row.Quantity));
                const product = catalogByNumber.get(productNumber);
                const unitPrice = Number(product?.price);
                if (!product || !Number.isFinite(unitPrice) ||
                    !Number.isFinite(quantity) || quantity <= 0) {
                    skipped += 1;
                    continue;
                }
                const existing = itemsByProduct.get(productNumber);
                if (existing) {
                    existing.quantity += quantity;
                } else {
                    itemsByProduct.set(productNumber, {
                        product_ID: product.ID,
                        productNumber: product.productNumber,
                        productName: product.name,
                        unit: product.unit || "",
                        quantity,
                        unitPrice
                    });
                }
            }

            const items = [...itemsByProduct.values()].map((item) => ({
                ...item,
                totalPrice: Number((item.unitPrice * item.quantity).toFixed(2))
            }));

            const orderDate = lastOrder.timestamp !== null
                ? new Date(lastOrder.timestamp).toISOString().slice(0, 10)
                : "";

            // Als Satzteil ("number 123 from October 29, 2026"), ohne Klammern.
            const spokenDate = lastOrder.timestamp !== null
                ? new Date(lastOrder.timestamp).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    timeZone: "UTC"
                })
                : "";
            const orderRef =
                `number ${lastOrder.id}` +
                (spokenDate ? ` from ${spokenDate}` : "");

            if (items.length === 0) {
                return {
                    ...emptyResult(
                        `I found the last order, ${orderRef}, but there's ` +
                            "nothing in it I can copy."
                    ),
                    orderNumber: lastOrder.id,
                    orderDate
                };
            }

            return {
                success: true,
                message:
                    `Done! I copied ${countOf(items.length, "item")} from the ` +
                    `last order, ${orderRef}.` +
                    (skipped > 0
                        ? ` I had to skip ${countOf(skipped, "item")} because ` +
                          (skipped === 1 ? "that product is" : "those products are") +
                          " no longer available."
                        : "") +
                    pickOne(
                        " Feel free to adjust it.",
                        " Have a look and change anything you like."
                    ),
                orderNumber: lastOrder.id,
                orderDate,
                items
            };

        } catch (error) {
            const statusCode = Number(
                error.statusCode || error.status || error.code
            );
            if (statusCode >= 400 && statusCode < 600) {
                return req.reject(statusCode, error.message);
            }
            console.error("Copying the last order failed:", error);
            return req.reject(
                500,
                `COPY_LAST_ORDER_FAILED: ${error.message}`
            );
        }
    });

    /**
     * PICO Intent Router (routeAiCommand).
     *
     * Empfängt einen beliebigen Freitext-Befehl aus dem EINEN PICO-
     * Eingabefeld und entscheidet mittels Sonnet, welche der sechs
     * Funktionen gemeint ist:
     *
     *   select_customer      -> selectCustomer
     *   generate_order_draft -> generateOrderDraft
     *   add_items            -> interpretOrderItems
     *   recommend_products   -> recommendProducts
     *   validate_order       -> validateOrderItems
     *   copy_last_order      -> copyLastOrder
     *
     * PICO führt selbst NICHTS aus - er liefert nur die Entscheidung
     * (status + intent) und ggf. einen Text, der dem Nutzer direkt
     * angezeigt wird (Rückfrage, Hinweis auf mehrere Funktionen,
     * freundliche Ablehnung bei unbekannten Anfragen).
     *
     * WICHTIG: "message" wird IMMER auf Englisch zurückgegeben,
     * unabhängig davon, in welcher Sprache der Nutzer seinen Befehl
     * eingegeben hat.
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
            }, AI_CORE_OPTIONS);

            const response = await client.chatCompletion({
                messages: [
                    {
                        role: "system",
                        content: `You are the intent router for PICO, an AI assistant that helps sales representatives create customer sales orders in a SAP-based application.

PICO can perform exactly six functions:

1. select_customer - identify and select the customer for the order, based on the customer's name and/or customer number.
2. generate_order_draft - automatically build an order draft from the customer's order history: frequently ordered products that are due for reorder are added to the order, less certain ones are offered as suggestions to confirm. Typical commands: "create an order draft", "prepare the usual order", "fill the order based on history".
3. add_items - interpret spoken or typed product names and quantities and add them as order line items to the current order draft, change the product or quantity of existing line items (for example "make it 10 instead", "replace X with Y"), or remove line items from the order draft (for example "remove the Nutella").
4. recommend_products - suggest products to consider adding to the order, based on the customer's historical order data, without adding anything automatically.
5. validate_order - check the current order draft's line items against the customer's order history and flag unusual product categories or quantities.
6. copy_last_order - copy the line items of the customer's most recent order into the order draft so that they can be adjusted afterwards. The command may name the customer (for example "copy the last order of customer Acme" or "copy the last order"). Naming the customer here is only a parameter of this function and does NOT make it a multiple-intent command.

Analyze the user's command and decide which single function is meant.

Rules:

- If the command clearly and unambiguously matches exactly ONE of the six functions, respond with status "ok" and set intent to that function's identifier (select_customer, generate_order_draft, add_items, recommend_products, validate_order, or copy_last_order). The message field can be a short one-sentence acknowledgement.
- If the command explicitly or implicitly asks for TWO OR MORE of the six functions to be performed together (for example "select customer Acme and add 5 Nutella"), respond with status "multiple_intents", intent set to an empty string, and a friendly message explaining that PICO can only execute one function per command and asking the user to submit the requests one at a time.
- If the command could reasonably match more than one function, or its meaning is unclear, respond with status "clarification_required", intent set to an empty string, and a short clarifying question that helps determine which of the six functions is meant.
- If the command does not relate to any of the six functions at all (for example small talk, unrelated topics, or requests PICO cannot fulfill), respond with status "unknown_intent", intent set to an empty string, and a very friendly message explaining that PICO cannot help with this, briefly restating the six things PICO can help with.

Always write the "message" field in English, regardless of the language of the input command. Write it as PICO speaking directly to the user in a warm, natural, conversational first-person tone ("I", "you"), in one or two short sentences, like a helpful colleague in a chat. Avoid technical or system-like wording. Vary your wording from one answer to the next, so that it sounds like a real person and not like a template. Whenever you need an answer from the user, end the message with one clear, direct question that can be answered in a few words.

Do not invent order data or customer data. Do not decide which specific customer, products, or quantities are meant - that happens later in a separate step. Your only job is to decide WHICH of the six functions applies.

For intent "copy_last_order" only: set "customerReference" to the customer name and/or number exactly as the user wrote it in the command, or to an empty string if the command does not name a customer. For all other intents set "customerReference" to an empty string.

Return only valid JSON in exactly this structure. Do not wrap the JSON in Markdown code fences.

{
  "status": "ok" | "clarification_required" | "multiple_intents" | "unknown_intent",
  "intent": "select_customer" | "generate_order_draft" | "add_items" | "recommend_products" | "validate_order" | "copy_last_order" | "",
  "message": "string",
  "customerReference": "string"
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
                message: parsedResponse.message || "",
                customerReference:
                    parsedResponse.status === "ok" &&
                    parsedResponse.intent === "copy_last_order"
                        ? String(parsedResponse.customerReference || "").trim()
                        : ""
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
