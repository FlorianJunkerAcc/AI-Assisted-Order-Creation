import cds from "@sap/cds";
import { OrchestrationClient } from "@sap-ai-sdk/orchestration";

// SELECT wird für Datenbankabfragen benötigt.
const { INSERT, SELECT, UPDATE } = cds.ql;

// Implementierung des SalesOrderService.
// Diese Datei wird automatisch mit der gleichnamigen CDS-Service-Datei verbunden.
export default cds.service.impl(async function () {

    // Holt die Entity Products aus dem aktuellen SalesOrderService.
    const { Customers, Products } = this.entities;
    const salesCloud = await cds.connect.to("SalesCloud");
    const { CorporateAccountCollection } = salesCloud.entities;

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
            address: customer.Address,
            city: ""
        }));
    });

    this.before("CREATE", "SalesOrders", async (req) => {
        const customerId = req.data.customer_ID;

        if (!customerId) {
            return;
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
             * Aktuelle Produkte aus der CAP-Datenbank lesen.
             *
             * Die Daten stammen bei dir ursprünglich aus der Products-CSV
             * und wurden von CAP nach SQLite geladen.
             */
            const products = await SELECT
                .from(Products)
                .columns(
                    "ID",
                    "productNumber",
                    "name",
                    "price"
                );

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
             * Produktkatalog für Sonnet in einen einfachen Text umwandeln.
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
});