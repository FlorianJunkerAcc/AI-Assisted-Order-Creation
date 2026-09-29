
sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/model/json/JSONModel",
        "sap/ui/core/Fragment",
        "sap/ui/model/Filter",
        "sap/ui/model/FilterOperator",
        "sap/m/MessageToast",
        "sap/m/MessageBox"
    ],
    function (
        PageController,
        JSONModel,
        Fragment,
        Filter,
        FilterOperator,
        MessageToast,
        MessageBox
    ) {
        "use strict";
        return PageController.extend(
            "com.prototype.salesorderai.salesorderui.ext.view.Main",
            {
                onInit: function () {
                    PageController.prototype.onInit.apply(
                        this,
                        arguments
                    );
                    this.getView().setModel(
                        new JSONModel({
                            items: [],
                            orderTotal: "0.00",
                            itemCount: 0,
                            canCreate: false
                        }),
                        "order"
                    );
                    this.getView().setModel(
                        new JSONModel({
                            visible: false,
                            question: "",
                            quantity: 1,
                            suggestions: [],
                            pending: []
                        }),
                        "clarification"
                    );
                    this.getView().setModel(
                        new JSONModel({
                            visible: false,
                            recommendations: []
                        }),
                        "recommendation"
                    );
                    this.getView().setModel(
                        new JSONModel({
                            visible: false,
                            message: "",
                            warnings: []
                        }),
                        "validation"
                    );
                    // PICO: Begruessung (greetingVisible) und Router-
                    // Nachrichten wie Rueckfragen, "nur eine Funktion pro
                    // Befehl" oder freundliche Ablehnung (messageVisible).
                    this.getView().setModel(
                        new JSONModel({
                            greetingVisible: false,
                            messageVisible: false,
                            message: ""
                        }),
                        "pico"
                    );
                    this.getView().setModel(
                        new JSONModel({
                            recognizedCommand: "",
                            isAiProcessing: false,
                            canSubmitAiCommand: false
                        }),
                        "ui"
                    );
                },
                onAddProduct: function () {
                    this._productEntryMode = true;
                    this._productOrderContext = null;
                    this._openProductValueHelp();
                },
                onHeaderChange: function () {
                    this._clearAiResultAreas();
                    this._updateCreateEnabled();
                },
                onAIInputChange: function () {
                    const sValue =
                        this.byId("aiOrderInput").getValue();
                    const oUiModel = this.getView().getModel("ui");
                    oUiModel.setProperty(
                        "/recognizedCommand",
                        sValue
                    );
                    this._updateAiSubmitState();
                },
                _updateAiSubmitState: function () {
                    const oUiModel = this.getView().getModel("ui");
                    const sCommand =
                        oUiModel.getProperty("/recognizedCommand") || "";
                    const bProcessing = Boolean(
                        oUiModel.getProperty("/isAiProcessing")
                    );
                    oUiModel.setProperty(
                        "/canSubmitAiCommand",
                        Boolean(sCommand.trim()) && !bProcessing
                    );
                },
                /**
                 * Setzt die Ergebnisbereiche ALLER drei PICO-Funktionen
                 * zurueck (Clarification, Recommendation, Validation).
                 *
                 * Wird bewusst zentral aufgerufen, statt jede Funktion nur
                 * ihr eigenes Ergebnis setzen zu lassen: sonst bleibt z.B.
                 * eine vorherige Produktempfehlung sichtbar, waehrend
                 * bereits das Ergebnis der Auftragsvalidierung angezeigt
                 * wird. Aufrufstellen: bei jedem neu erkannten Intent
                 * (onAskPico, Status "ok") sowie beim Kundenwechsel
                 * (onHeaderChange) und beim Zuruecksetzen des Formulars.
                 */
                _clearAiResultAreas: function () {
                    this.getView().getModel("clarification").setData({
                        visible: false,
                        question: "",
                        quantity: 1,
                        suggestions: [],
                        pending: []
                    });
                    this.getView().getModel("recommendation").setData({
                        visible: false,
                        recommendations: []
                    });
                    this.getView().getModel("validation").setData({
                        visible: false,
                        message: "",
                        warnings: []
                    });
                },
                /**
                 * Entfernt eine Position aus dem Auftragsentwurf.
                 */
                onDeleteProduct: function (oEvent) {
                    const oOrderModel =
                        this.getView().getModel("order");
                    const oContext =
                        oEvent.getSource().getBindingContext("order");
                    const sPath = oContext.getPath();
                    const iIndex = Number(
                        sPath.split("/").pop()
                    );
                    const aItems =
                        oOrderModel.getProperty("/items");
                    aItems.splice(iIndex, 1);
                    oOrderModel.setProperty(
                        "/items",
                        aItems
                    );
                    this._calculateOrderTotal();
                },
                onProductValueHelpRequest: function (oEvent) {
                    this._productOrderContext =
                        oEvent.getSource().getBindingContext("order");
                    this._productEntryMode = false;
                    this._openProductValueHelp();
                },
                _openProductValueHelp: function () {
                    if (!this._productValueHelpPromise) {
                        this._productValueHelpPromise = Fragment.load({
                            id: this.getView().getId(),
                            name: "com.prototype.salesorderai.salesorderui.ext.fragment.ProductValueHelp",
                            controller: this
                        }).then(function (oDialog) {
                            this.getView().addDependent(oDialog);
                            return oDialog;
                        }.bind(this));
                    }
                    this._productValueHelpPromise
                        .then(function (oDialog) {
                            this._clearProductFilterFields();
                            const oProductBinding = this.byId(
                                "productTable"
                            ).getBinding("items");
                            if (oProductBinding) {
                                oProductBinding.refresh();
                            }
                            oDialog.open();
                        }.bind(this))
                        .catch(function (oError) {
                            console.error(
                                "Could not open product value help:",
                                oError
                            );
                            MessageBox.error(
                                "The product selection could not be opened."
                            );
                        });
                },
                onProductTableUpdateFinished: function (oEvent) {
                    const oTable = oEvent.getSource();
                    const aItems = this.getView()
                        .getModel("order")
                        .getProperty("/items") || [];
                    oTable.getItems().forEach(function (oItem) {
                        const oContext = oItem.getBindingContext();
                        const sProductId = oContext &&
                            oContext.getProperty("ID");
                        // Ein Produkt ohne gültige ID darf niemals als
                        // "bereits enthalten" markiert werden. Das verhindert
                        // false positives, falls product_ID oder ID undefined ist.
                        if (!sProductId) {
                            oItem.toggleStyleClass(
                                "productAlreadyInOrder",
                                false
                            );
                            return;
                        }
                        const bAlreadyInOrder = aItems.some(
                            function (oOrderItem) {
                                return Boolean(oOrderItem.product_ID) &&
                                    String(oOrderItem.product_ID) === String(sProductId);
                            }
                        );
                        oItem.toggleStyleClass(
                            "productAlreadyInOrder",
                            bAlreadyInOrder
                        );
                    });
                },
                onApplyProductFilters: function () {
                    this._applyProductFilters();
                },
                _applyProductFilters: function () {
                    const oDialog = this.byId("productValueHelpDialog");
                    if (!oDialog) {
                        return;
                    }
                    const oBinding = this.byId(
                        "productTable"
                    ).getBinding("items");
                    const oProductNumber = this.byId(
                        "productNumberFilter"
                    );
                    const oProductCategory = this.byId(
                        "productCategoryFilter"
                    );
                    const oSearchField = this.byId(
                        "productFreeTextFilter"
                    );
                    const sProductNumber = oProductNumber
                        ? oProductNumber.getValue().trim()
                        : "";
                    const sProductCategory = oProductCategory
                        ? oProductCategory.getValue().trim()
                        : "";
                    const sFreeText = oSearchField
                        ? oSearchField.getValue().trim()
                        : "";
                    const aFilters = [];
                    if (sFreeText) {
                        aFilters.push(new Filter({
                            filters: [
                                new Filter(
                                    "productNumber",
                                    FilterOperator.Contains,
                                    sFreeText
                                ),
                                new Filter(
                                    "name",
                                    FilterOperator.Contains,
                                    sFreeText
                                ),
                                new Filter(
                                    "productCategoryID",
                                    FilterOperator.Contains,
                                    sFreeText
                                )
                            ],
                            and: false
                        }));
                    }
                    if (sProductNumber) {
                        const bPrefixSearch =
                            sProductNumber.endsWith("*");
                        const sProductNumberQuery = bPrefixSearch
                            ? sProductNumber.slice(0, -1)
                            : sProductNumber;
                        if (sProductNumberQuery) {
                            aFilters.push(new Filter(
                                "productNumber",
                                bPrefixSearch
                                    ? FilterOperator.StartsWith
                                    : FilterOperator.Contains,
                                sProductNumberQuery
                            ));
                        }
                    }
                    if (sProductCategory) {
                        aFilters.push(new Filter(
                            "productCategoryID",
                            FilterOperator.Contains,
                            sProductCategory
                        ));
                    }
                    oBinding.filter(aFilters);
                },
                onClearProductFilters: function () {
                    this._clearProductFilterFields();
                    this._applyProductFilters();
                },
                _clearProductFilterFields: function () {
                    const oProductNumber = this.byId(
                        "productNumberFilter"
                    );
                    const oProductCategory = this.byId(
                        "productCategoryFilter"
                    );
                    if (oProductNumber) {
                        oProductNumber.setValue("");
                    }
                    if (oProductCategory) {
                        oProductCategory.setValue("");
                    }
                    const oSearchField = this.byId(
                        "productFreeTextFilter"
                    );
                    if (oSearchField) {
                        oSearchField.setValue("");
                    }
                },
                onProductValueHelpConfirm: async function () {
                    const oSelectedItem = this.byId(
                        "productTable"
                    ).getSelectedItem();
                    const oOrderContext = this._productOrderContext;
                    if (!oSelectedItem ||
                        (!oOrderContext && !this._productEntryMode)) {
                        MessageBox.warning("Please select a product.");
                        return;
                    }
                    try {
                        const oProductContext =
                            oSelectedItem.getBindingContext();
                        if (this._productEntryMode) {
                            const sProductID =
                                await oProductContext.requestProperty("ID");
                            const sProductName =
                                await oProductContext.requestProperty("name");
                            const sUnit =
                                await oProductContext.requestProperty("unit");
                            const vPrice =
                                await oProductContext.requestProperty("price");
                            const oOrderModel =
                                this.getView().getModel("order");
                            const aItems =
                                oOrderModel.getProperty("/items") || [];
                            const sNormalizedProductID =
                                String(sProductID).trim();
                            const iExistingIndex = aItems.findIndex(
                                function (oItem) {
                                    return String(oItem.product_ID).trim() ===
                                        sNormalizedProductID;
                                }
                            );
                            const fUnitPrice = Number(vPrice || 0);
                            let iFocusIndex;
                            if (iExistingIndex >= 0) {
                                const oExistingItem =
                                    aItems[iExistingIndex];
                                oExistingItem.quantity =
                                    Number(oExistingItem.quantity) + 1;
                                oExistingItem.totalPrice = (
                                    oExistingItem.quantity *
                                    Number(oExistingItem.unitPrice)
                                ).toFixed(2);
                                iFocusIndex = iExistingIndex;
                                MessageToast.show(
                                    `Quantity of ${oExistingItem.productName} ` +
                                    `updated to ${oExistingItem.quantity}.`
                                );
                            } else {
                                aItems.push({
                                    product_ID: sProductID,
                                    productName: sProductName,
                                    unit: sUnit,
                                    quantity: 1,
                                    unitPrice: fUnitPrice.toFixed(2),
                                    totalPrice: fUnitPrice.toFixed(2)
                                });
                                iFocusIndex = aItems.length - 1;
                                MessageToast.show(
                                    `${sProductName} added to the order.`
                                );
                            }
                            oOrderModel.setProperty("/items", aItems);
                            this._calculateOrderTotal();
                            this._focusOrderQuantity(iFocusIndex);
                        } else {
                            await this._setSelectedProduct(
                                oProductContext,
                                oOrderContext
                            );
                        }
                        this.byId("productValueHelpDialog").close();
                        this._productOrderContext = null;
                        this._productEntryMode = false;
                    } catch (oError) {
                        console.error(
                            "Could not read product:",
                            oError
                        );
                        MessageBox.error(
                            "The product price could not be read."
                        );
                    }
                },
                onProductValueHelpCancel: function () {
                    this._productOrderContext = null;
                    this._productEntryMode = false;
                    this.byId("productValueHelpDialog").close();
                },
                _focusOrderQuantity: function (iIndex) {
                    const oTable = this.byId("orderItemsTable");
                    if (!oTable) {
                        return;
                    }
                    const oRow = oTable.getItems()[iIndex];
                    if (oRow) {
                        oRow.getCells()[2].focus();
                    }
                },
                _setSelectedProduct: async function (
                    oProductContext,
                    oOrderContext
                ) {
                    const sProductID =
                        await oProductContext.requestProperty("ID");
                    const sProductName =
                        await oProductContext.requestProperty("name");
                    const sUnit =
                        await oProductContext.requestProperty("unit");
                    const vPrice =
                        await oProductContext.requestProperty("price");
                    const iQuantity =
                        Number(oOrderContext.getProperty("quantity")) || 1;
                    const fUnitPrice = Number(vPrice) || 0;
                    const fTotalPrice = fUnitPrice * iQuantity;
                    const sPath = oOrderContext.getPath();
                    const oModel = oOrderContext.getModel();
                    const aItems = oModel.getProperty("/items") || [];
                    const oExistingItem = aItems.find(function (oItem) {
                        return (
                            oItem.product_ID === sProductID &&
                            oItem !== oOrderContext.getObject()
                        );
                    });
                    if (oExistingItem) {
                        oExistingItem.quantity += iQuantity;
                        oExistingItem.totalPrice = (
                            oExistingItem.quantity *
                            Number(oExistingItem.unitPrice)
                        ).toFixed(2);
                        aItems.splice(
                            aItems.indexOf(oOrderContext.getObject()),
                            1
                        );
                        oModel.setProperty("/items", aItems);
                        this._calculateOrderTotal();
                        MessageToast.show(
                            `Quantity of ${sProductName} updated to ` +
                            `${oExistingItem.quantity}.`
                        );
                        return;
                    }
                    oModel.setProperty(sPath + "/product_ID", sProductID);
                    oModel.setProperty(sPath + "/productName", sProductName);
                    oModel.setProperty(sPath + "/unit", sUnit);
                    oModel.setProperty(
                        sPath + "/unitPrice",
                        fUnitPrice.toFixed(2)
                    );
                    oModel.setProperty(
                        sPath + "/totalPrice",
                        fTotalPrice.toFixed(2)
                    );
                    this._productOrderContext = null;
                    this._calculateOrderTotal();
                },
                /**
                 * Wird ausgeführt, sobald der Benutzer die Menge
                 * in einer Tabellenzeile ändert (StepInput-Change-Event).
                 */
                onQuantityChange: function (oEvent) {
                    const oInput =
                        oEvent.getSource();
                    const oContext =
                        oInput.getBindingContext("order");
                    if (!oContext) {
                        return;
                    }
                    const iQuantity =
                        Number(
                            oEvent.getParameter("value")
                        ) || 0;
                    const fUnitPrice =
                        Number(
                            oContext.getProperty("unitPrice")
                        ) || 0;
                    const fTotalPrice =
                        iQuantity * fUnitPrice;
                    oContext.getModel().setProperty(
                        oContext.getPath() + "/quantity",
                        iQuantity
                    );
                    oContext.getModel().setProperty(
                        oContext.getPath() + "/totalPrice",
                        fTotalPrice.toFixed(2)
                    );
                    this._calculateOrderTotal();
                },
                _addAiItemsToOrder: function (aResolvedItems) {
                    const oOrderModel =
                        this.getView().getModel("order");
                    const aAiItems = aResolvedItems.map(function (oItem) {
                        return {
                            product_ID: oItem.product_ID,
                            productName: oItem.productName || "",
                            unit: oItem.unit || "",
                            quantity: Number(oItem.quantity),
                            unitPrice: Number(oItem.unitPrice).toFixed(2),
                            totalPrice: Number(oItem.totalPrice).toFixed(2)
                        };
                    });
                    const aExistingItems =
                        (oOrderModel.getProperty("/items") || []).filter(
                            function (oItem) {
                                return Boolean(oItem.product_ID);
                            }
                        );
                    aAiItems.forEach(function (oNewItem) {
                        const oExistingItem = aExistingItems.find(
                            function (oItem) {
                                return oItem.product_ID === oNewItem.product_ID;
                            }
                        );
                        if (oExistingItem) {
                            oExistingItem.quantity += oNewItem.quantity;
                            oExistingItem.totalPrice = (
                                oExistingItem.quantity * Number(oExistingItem.unitPrice)
                            ).toFixed(2);
                        } else {
                            aExistingItems.push(oNewItem);
                        }
                    });
                    oOrderModel.setProperty("/items", aExistingItems);
                    this._calculateOrderTotal();
                },
                onSelectClarificationSuggestion: function (oEvent) {
                    const oButton = oEvent.getSource();
                    const oContext = oButton.getBindingContext("clarification");
                    const oSuggestion = oContext.getObject();
                    const oClarificationModel =
                        this.getView().getModel("clarification");
                    const iQuantity =
                        oClarificationModel.getProperty("/quantity") || 1;
                    const oODataModel = this.getView().getModel();
                    const oProductBinding = oODataModel.bindContext(
                        `/Products(${oSuggestion.productId})`
                    );
                    oProductBinding.getBoundContext()
                        .requestObject()
                        .then(
                            function (oProduct) {
                                const fUnitPrice = Number(oProduct.price);
                                const fTotalPrice = fUnitPrice * iQuantity;
                                this._addAiItemsToOrder([{
                                    product_ID: oSuggestion.productId,
                                    productName: oSuggestion.productName,
                                    quantity: iQuantity,
                                    unitPrice: fUnitPrice,
                                    totalPrice: fTotalPrice
                                }]);
                                MessageToast.show(
                                    `${oSuggestion.productName} added to the order draft`
                                );
                                this._advanceToNextClarification();
                            }.bind(this)
                        )
                        .catch(
                            function (oError) {
                                console.error(
                                    "Could not load selected product:",
                                    oError
                                );
                                MessageBox.error(
                                    "The selected product could not be loaded."
                                );
                            }
                        );
                },
                _advanceToNextClarification: function () {
                    const oClarificationModel =
                        this.getView().getModel("clarification");
                    const aPending =
                        oClarificationModel.getProperty("/pending") || [];
                    if (aPending.length > 0) {
                        const oNextClarification = aPending[0];
                        const aRemainingClarifications = aPending.slice(1);
                        oClarificationModel.setData({
                            visible: true,
                            question: oNextClarification.question,
                            quantity: oNextClarification.quantity,
                            suggestions: oNextClarification.suggestions,
                            pending: aRemainingClarifications
                        });
                        return;
                    }
                    oClarificationModel.setData({
                        visible: false,
                        question: "",
                        quantity: 1,
                        suggestions: [],
                        pending: []
                    });
                },
                /**
                 * Berechnet den Gesamtwert des Auftragsentwurfs.
                 */
                _calculateOrderTotal: function () {
                    const oOrderModel =
                        this.getView().getModel("order");
                    const aItems =
                        oOrderModel.getProperty("/items") || [];
                    aItems.forEach(function (oItem, iIndex) {
                        oItem.position = (iIndex + 1) * 10;
                    });
                    oOrderModel.setProperty("/items", aItems);
                    const fOrderTotal = aItems.reduce(
                        function (fSum, oItem) {
                            return (
                                fSum +
                                (
                                    Number(
                                        oItem.totalPrice
                                    ) || 0
                                )
                            );
                        },
                        0
                    );
                    oOrderModel.setProperty(
                        "/orderTotal",
                        fOrderTotal.toFixed(2)
                    );
                    oOrderModel.setProperty(
                        "/itemCount",
                        aItems.length
                    );
                    const oProductTable = this.byId("productTable");
                    if (oProductTable) {
                        this.onProductTableUpdateFinished({
                            getSource: function () {
                                return oProductTable;
                            }
                        });
                    }
                    this._updateCreateEnabled();
                },
                _updateCreateEnabled: function () {
                    const aItems = this.getView()
                        .getModel("order")
                        .getProperty("/items") || [];
                    const bCanCreate = Boolean(
                        aItems.length &&
                        !this._isCreatingOrder
                    );
                    this.getView()
                        .getModel("order")
                        .setProperty("/canCreate", bCanCreate);
                },
                /**
                 * Blendet PICO ein bzw. aus.
                 * Der Bereich ist in der XML-View zunächst
                 * mit visible="false" versteckt. Beim Oeffnen wird
                 * immer die Begruessung gezeigt und alle vorherigen
                 * Ergebnisbereiche werden geleert, beim Schliessen
                 * werden Begruessung und Router-Nachricht zurueckgesetzt.
                 */
                onStartPico: function () {
                    const oArea = this.byId("aiAssistantArea");
                    const oButton = this.byId("startPicoButton");
                    const bVisible = oArea.getVisible();
                    oArea.setVisible(!bVisible);

                    const oResourceBundle =
                        this.getView().getModel("i18n").getResourceBundle();
                    oButton.setText(
                        oResourceBundle.getText(
                            bVisible ? "startPico" : "picoCollapse"
                        )
                    );

                    const oPicoModel = this.getView().getModel("pico");
                    if (!bVisible) {
                        oPicoModel.setData({
                            greetingVisible: true,
                            messageVisible: false,
                            message: ""
                        });
                        this._clearAiResultAreas();
                        this.byId("aiOrderInput").focus();
                    } else {
                        oPicoModel.setData({
                            greetingVisible: false,
                            messageVisible: false,
                            message: ""
                        });
                    }
                },
                /**
                 * Zentraler Einstiegspunkt: nimmt den Freitext-Befehl aus
                 * dem PICO-Eingabefeld entgegen, ruft zuerst den Intent-
                 * Router (routeAiCommand) auf und dispatcht anschliessend
                 * je nach erkannter Absicht an genau eine der drei
                 * bestehenden Funktionen. PICO selbst legt nie einen
                 * Sales Order an und veraendert nie direkt den Entwurf -
                 * das passiert weiterhin ausschliesslich in den bereits
                 * vorhandenen Funktionen (_runAddItems,
                 * _runRecommendProducts, _runValidateOrder).
                 */
                onAskPico: async function () {
                    const oButton = this.byId("askPicoButton");
                    const oUiModel = this.getView().getModel("ui");
                    const oPicoModel = this.getView().getModel("pico");

                    const sCommand = (
                        oUiModel.getProperty("/recognizedCommand") || ""
                    ).trim();

                    if (!sCommand) {
                        MessageBox.warning(
                            "Please enter a command for PICO."
                        );
                        return;
                    }

                    const oModel = this.getView().getModel();
                    const oActionBinding = oModel.bindContext(
                        "/routeAiCommand(...)"
                    );
                    oActionBinding.setParameter("command", sCommand);

                    try {
                        oUiModel.setProperty("/isAiProcessing", true);
                        this._updateAiSubmitState();
                        oButton.setBusy(true);
                        oPicoModel.setProperty("/messageVisible", false);

                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "PICO returned no result context."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        console.log("PICO routing result:", oResult);

                        switch (oResult.status) {

                            case "multiple_intents":
                            case "unknown_intent":
                            case "clarification_required":
                                // Eingabe bewusst NICHT leeren, damit der
                                // Nutzer sie direkt praezisieren kann.
                                oPicoModel.setData({
                                    greetingVisible: false,
                                    messageVisible: true,
                                    message: oResult.message || ""
                                });
                                break;

                            case "ok": {
                                oPicoModel.setProperty(
                                    "/messageVisible",
                                    false
                                );
                                // Neuer, eindeutig erkannter Intent: zuerst
                                // ALLE bisherigen Ergebnisbereiche leeren
                                // (Clarification, Recommendation,
                                // Validation), damit z.B. eine vorherige
                                // Produktempfehlung nicht sichtbar bleibt,
                                // waehrend bereits das Validierungsergebnis
                                // angezeigt wird. Erst danach die neue
                                // Funktion ausfuehren.
                                this._clearAiResultAreas();

                                // Befehl wurde eindeutig erkannt und wird
                                // jetzt ausgefuehrt - Eingabefeld leeren.
                                oUiModel.setProperty(
                                    "/recognizedCommand",
                                    ""
                                );
                                this.byId("aiOrderInput").setValue("");

                                if (oResult.intent === "add_items") {
                                    await this._runAddItems(sCommand);
                                } else if (
                                    oResult.intent === "recommend_products"
                                ) {
                                    await this._runRecommendProducts();
                                } else if (
                                    oResult.intent === "validate_order"
                                ) {
                                    await this._runValidateOrder();
                                } else {
                                    MessageBox.error(
                                        "PICO returned an unrecognized function."
                                    );
                                }
                                break;
                            }

                            default:
                                MessageBox.error(
                                    "PICO returned an unexpected response."
                                );
                        }

                    } catch (oError) {
                        console.error("PICO routing failed:", oError);
                        MessageBox.error(
                            "PICO Error: " +
                            (oError.message || String(oError))
                        );
                    } finally {
                        oUiModel.setProperty("/isAiProcessing", false);
                        this._updateAiSubmitState();
                        oButton.setBusy(false);
                    }
                },
                /**
                 * Interpretiert Produkte/Mengen aus natuerlicher Sprache
                 * (interpretOrderItems) und fuegt sie dem Auftragsentwurf
                 * hinzu. Wird ausschliesslich von onAskPico aufgerufen,
                 * nachdem PICO den Intent "add_items" erkannt hat.
                 */
                _runAddItems: async function (sOrderRequest) {
                    const oModel = this.getView().getModel();
                    const oActionBinding = oModel.bindContext(
                        "/interpretOrderItems(...)"
                    );
                    oActionBinding.setParameter(
                        "orderRequest",
                        sOrderRequest
                    );

                    try {
                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "The AI service returned no result context."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        console.log(
                            "AI interpretation result:",
                            oResult
                        );

                        if (!oResult.success) {
                            MessageBox.warning(
                                oResult.message ||
                                "The request could not be processed."
                            );
                            return;
                        }

                        const aClarifications = Array.isArray(
                            oResult.clarifications
                        ) ? oResult.clarifications : [];
                        const aResolvedItems = Array.isArray(oResult.items)
                            ? oResult.items
                            : [];

                        if (aClarifications.length > 0) {
                            const oClarificationModel =
                                this.getView().getModel("clarification");
                            const oFirstClarification = aClarifications[0];
                            const aRemainingClarifications =
                                aClarifications.slice(1);
                            oClarificationModel.setData({
                                visible: true,
                                question: oFirstClarification.question,
                                quantity: oFirstClarification.quantity,
                                suggestions: oFirstClarification.suggestions,
                                pending: aRemainingClarifications
                            });
                            if (aResolvedItems.length > 0) {
                                this._addAiItemsToOrder(aResolvedItems);
                            }
                            MessageToast.show(
                                "Please clarify the highlighted product."
                            );
                            return;
                        }

                        if (aResolvedItems.length === 0) {
                            MessageBox.warning(
                                oResult.message ||
                                "No matching products were identified."
                            );
                            return;
                        }

                        this._addAiItemsToOrder(aResolvedItems);
                        MessageToast.show(
                            `${aResolvedItems.length} item(s) added to the order draft`
                        );

                    } catch (oError) {
                        console.error(
                            "AI order interpretation failed:",
                            oError
                        );
                        MessageBox.error(
                            "AI Error: " +
                            (oError.message || String(oError))
                        );
                    }
                },
                /**
                 * Fordert Produktempfehlungen fuer den gewaehlten Kunden an
                 * (recommendProducts). Wird ausschliesslich von onAskPico
                 * aufgerufen, nachdem PICO den Intent "recommend_products"
                 * erkannt hat.
                 */
                _runRecommendProducts: async function () {
                    const oCustomerItem =
                        this.byId("customerSelect").getSelectedItem();
                    if (!oCustomerItem) {
                        MessageBox.warning(
                            "Please select a customer to get product recommendations."
                        );
                        return;
                    }

                    const oRecommendationModel =
                        this.getView().getModel("recommendation");

                    const aOrderItems =
                        this.getView().getModel("order")
                            .getProperty("/items") || [];

                    const oActionBinding =
                        this.getView().getModel().bindContext(
                            "/recommendProducts(...)"
                        );

                    try {
                        const oCustomerContext =
                            oCustomerItem.getBindingContext();
                        const sCustomerID =
                            await oCustomerContext.requestProperty("ID");

                        oActionBinding.setParameter(
                            "customerId",
                            sCustomerID
                        );
                        oActionBinding.setParameter(
                            "excludedProductIDs",
                            JSON.stringify(
                                [...new Set(aOrderItems
                                    .map((item) => item.product_ID)
                                    .filter(Boolean))]
                            )
                        );

                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "The recommendation service returned no result."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        const aRecommendations =
                            Array.isArray(oResult.recommendations)
                                ? oResult.recommendations
                                : [];

                        if (!oResult.success || aRecommendations.length === 0) {
                            oRecommendationModel.setData({
                                visible: false,
                                recommendations: []
                            });
                            MessageToast.show(
                                oResult.message ||
                                    "No product recommendations were found."
                            );
                            return;
                        }

                        oRecommendationModel.setData({
                            visible: true,
                            recommendations: aRecommendations
                        });

                    } catch (oError) {
                        console.error(
                            "Could not load product recommendations:",
                            oError
                        );
                        MessageBox.error(
                            "Product recommendations could not be loaded: " +
                                (oError.message || String(oError))
                        );
                    }
                },
                /**
                 * Adds the selected recommendation to the draft and removes
                 * only that product from the displayed recommendations.
                 */
                onSelectRecommendedProduct: function (oEvent) {
                    const oContext =
                        oEvent.getSource().getBindingContext("recommendation");
                    const oRecommendation = oContext?.getObject();
                    if (!oRecommendation?.product_ID) {
                        MessageBox.error(
                            "The selected product recommendation is invalid."
                        );
                        return;
                    }
                    const fUnitPrice = Number(oRecommendation.unitPrice);

                    const iRecommendedQuantity = Number.isInteger(
                        oRecommendation.averageQuantity
                    ) && oRecommendation.averageQuantity > 0
                        ? oRecommendation.averageQuantity
                        : 1;

                    this._addAiItemsToOrder([{
                        product_ID: oRecommendation.product_ID,
                        productName: oRecommendation.productName,
                        unit: oRecommendation.unit || "",
                        quantity: iRecommendedQuantity,
                        unitPrice: fUnitPrice,
                        totalPrice: fUnitPrice * iRecommendedQuantity
                    }]);
                    const oRecommendationModel =
                        this.getView().getModel("recommendation");
                    const aRemainingRecommendations =
                        (oRecommendationModel.getProperty(
                            "/recommendations"
                        ) || []).filter(
                            (item) =>
                                item.product_ID !==
                                oRecommendation.product_ID
                        );
                    oRecommendationModel.setData({
                        visible: aRemainingRecommendations.length > 0,
                        recommendations: aRemainingRecommendations
                    });
                    MessageToast.show(
                        `${oRecommendation.productName} (Qty ${iRecommendedQuantity}) added to the order draft.`
                    );
                },
                /**
                 * Validiert die aktuellen Auftragspositionen gegen die
                 * Bestellhistorie des gewaehlten Kunden (validateOrderItems).
                 * Wird ausschliesslich von onAskPico aufgerufen, nachdem
                 * PICO den Intent "validate_order" erkannt hat.
                 */
                _runValidateOrder: async function () {
                    const oCustomerItem =
                        this.byId("customerSelect").getSelectedItem();
                    if (!oCustomerItem) {
                        MessageBox.warning(
                            "Please select a customer before validating the order."
                        );
                        return;
                    }

                    const aOrderItems =
                        this.getView().getModel("order")
                            .getProperty("/items") || [];
                    const aValidItems = aOrderItems.filter(
                        (item) => item.product_ID && Number(item.quantity) > 0
                    );

                    if (aValidItems.length === 0) {
                        MessageBox.warning(
                            "Please add at least one product before validating the order."
                        );
                        return;
                    }

                    const oValidationModel =
                        this.getView().getModel("validation");

                    const oActionBinding =
                        this.getView().getModel().bindContext(
                            "/validateOrderItems(...)"
                        );

                    try {
                        const oCustomerContext =
                            oCustomerItem.getBindingContext();
                        const sCustomerID =
                            await oCustomerContext.requestProperty("ID");

                        oActionBinding.setParameter(
                            "customerId",
                            sCustomerID
                        );
                        oActionBinding.setParameter(
                            "items",
                            JSON.stringify(
                                aValidItems.map((item) => ({
                                    position: Number(item.position),
                                    product_ID: item.product_ID,
                                    quantity: Number(item.quantity)
                                }))
                            )
                        );

                        await oActionBinding.execute();

                        const oResultContext =
                            oActionBinding.getBoundContext();
                        if (!oResultContext) {
                            throw new Error(
                                "The validation service returned no result."
                            );
                        }

                        const oResult =
                            await oResultContext.requestObject();

                        const aWarnings = Array.isArray(oResult.warnings)
                            ? oResult.warnings
                            : [];

                        oValidationModel.setData({
                            visible: true,
                            message: oResult.message || "",
                            warnings: aWarnings
                        });

                        if (aWarnings.length === 0) {
                            MessageToast.show(
                                oResult.message ||
                                    "No issues found in this order."
                            );
                        }

                    } catch (oError) {
                        console.error(
                            "Order validation failed:",
                            oError
                        );
                        MessageBox.error(
                            "Order validation could not be completed: " +
                                (oError.message || String(oError))
                        );
                    }
                },
                onStartVoiceInput: function () {
                    const SpeechRecognition =
                        window.SpeechRecognition ||
                        window.webkitSpeechRecognition;
                    if (!SpeechRecognition) {
                        MessageBox.error(
                            "Speech recognition is not supported by this browser."
                        );
                        return;
                    }
                    const oRecognition = new SpeechRecognition();
                    oRecognition.lang = "en-US";
                    oRecognition.continuous = false;
                    oRecognition.interimResults = false;
                    const oListeningIndicator =
                        this.byId("voiceListeningIndicator");
                    const oVoiceButton =
                        this.byId("startVoiceInputButton");
                    const oController = this;
                    const oResourceBundle =
                        this.getView().getModel("i18n").getResourceBundle();
                    oRecognition.onstart = function () {
                        oListeningIndicator.setVisible(true);
                        oVoiceButton.setEnabled(false);
                        oVoiceButton.setText(
                            oResourceBundle.getText("listening")
                        );
                    };
                    oRecognition.onresult = function (oEvent) {
                        const sTranscript =
                            oEvent.results[0][0].transcript;
                        console.log(
                            "Voice input:",
                            sTranscript
                        );
                        oController.getView().getModel("ui").setProperty(
                            "/recognizedCommand",
                            sTranscript
                        );
                        oController._updateAiSubmitState();
                    };
                    oRecognition.onend = function () {
                        oListeningIndicator.setVisible(false);
                        oVoiceButton.setEnabled(true);
                        oVoiceButton.setText(
                            oResourceBundle.getText("startVoiceInput")
                        );
                    };
                    oRecognition.onerror = function (oEvent) {
                        console.error(
                            "Speech recognition error:",
                            oEvent.error
                        );
                        oListeningIndicator.setVisible(false);
                        oVoiceButton.setEnabled(true);
                        oVoiceButton.setText(
                            oResourceBundle.getText("startVoiceInput")
                        );
                        MessageBox.error(
                            "Voice recognition failed: " +
                            oEvent.error
                        );
                    };
                    oRecognition.start();
                },
                /**
                 * Speichert den vollständigen Sales Order.
                 * Diese Methode bleibt die einzige Stelle,
                 * die einen Auftrag tatsächlich anlegt.
                 */
                onCreateOrder: async function () {
                    try {
                        const oModel =
                            this.getView().getModel();
                        const oCustomerItem =
                            this.byId(
                                "customerSelect"
                            ).getSelectedItem();
                        const sStatus =
                            this.byId(
                                "statusInput"
                            ).getText();
                        const aUiItems =
                            this.getView()
                                .getModel("order")
                                .getProperty("/items");
                        if (!oCustomerItem) {
                            MessageBox.warning(
                                "Please select a customer."
                            );
                            return;
                        }
                        if (!aUiItems.length) {
                            MessageBox.warning(
                                "Please add at least one product."
                            );
                            return;
                        }
                        const bInvalidItem =
                            aUiItems.some(
                                function (oItem) {
                                    return (
                                        !oItem.product_ID ||
                                        !oItem.quantity ||
                                        oItem.quantity <= 0
                                    );
                                }
                            );
                        if (bInvalidItem) {
                            MessageBox.warning(
                                "Please select a product and enter a valid quantity for every item."
                            );
                            return;
                        }
                        const oCustomerContext =
                            oCustomerItem.getBindingContext();
                        const sCustomerID =
                            await oCustomerContext.requestProperty(
                                "ID"
                            );
                        const aOrderItems =
                            aUiItems.map(
                                function (oItem) {
                                    return {
                                        product_ID:
                                            oItem.product_ID,
                                        quantity:
                                            Number(
                                                oItem.quantity
                                            ),
                                        position:
                                            Number(oItem.position),
                                        price:
                                            Number(
                                                oItem.unitPrice
                                            )
                                    };
                                }
                            );
                        const oSalesOrder = {
                            status:
                                sStatus,
                            customer_ID:
                                sCustomerID,
                            items:
                                aOrderItems
                        };
                        console.log(
                            "Sales Order payload:",
                            oSalesOrder
                        );
                        const oView = this.getView();
                        oView.setBusyIndicatorDelay(0);
                        oView.setBusy(true);
                        this._isCreatingOrder = true;
                        this._updateCreateEnabled();
                        const oListBinding =
                            oModel.bindList(
                                "/SalesOrders"
                            );
                        const oContext =
                            oListBinding.create(
                                oSalesOrder
                            );
                        await oContext.created();
                        const sOrderNumber =
                            await oContext.requestProperty("orderNumber");
                        const sOrderPayload =
                            await oContext.requestProperty(
                                "salesCloudOrderPayload"
                            );
                        const sItemPayloads =
                            await oContext.requestProperty(
                                "salesCloudItemPayloads"
                            );
                        MessageBox.success(
                            "Sales Order " + sOrderNumber +
                            " created successfully.\n\n" +
                            "Order payload:\n" +
                            JSON.stringify(JSON.parse(sOrderPayload), null, 2) +
                            "\n\nOrder item payloads:\n" +
                            JSON.stringify(JSON.parse(sItemPayloads), null, 2),
                            {
                                title: "Sales Order Created"
                            }
                        );
                        this._resetOrderForm();
                    } catch (oError) {
                        console.error(
                            "Create Sales Order failed:",
                            oError
                        );
                        MessageBox.error(
                            "The Sales Order could not be created.\n\n" +
                            (oError.message || String(oError)),
                            {
                                title: "Sales Order Creation Failed"
                            }
                        );
                    } finally {
                        this.getView().setBusy(false);
                        this._isCreatingOrder = false;
                        this._updateCreateEnabled();
                    }
                },
                /**
                 * Setzt die komplette Eingabemaske zurück,
                 * nachdem der Auftrag angelegt wurde.
                 */
                _resetOrderForm: function () {
                    this.byId(
                        "customerSelect"
                    ).setSelectedKey("");
                    this.byId(
                        "statusInput"
                    ).setText("Draft");
                    this.getView()
                        .getModel("ui")
                        .setData({
                            recognizedCommand: "",
                            isAiProcessing: false,
                            canSubmitAiCommand: false
                        });
                    this.byId(
                        "aiAssistantArea"
                    ).setVisible(false);
                    this.byId(
                        "startPicoButton"
                    ).setText(
                        this.getView().getModel("i18n")
                            .getResourceBundle()
                            .getText("startPico")
                    );
                    this.getView()
                        .getModel("pico")
                        .setData({
                            greetingVisible: false,
                            messageVisible: false,
                            message: ""
                        });
                    this._clearAiResultAreas();
                    this.getView()
                        .getModel("order")
                        .setData({
                            items: [],
                            orderTotal: "0.00",
                            itemCount: 0,
                            canCreate: false
                        });
                }
            }
        );
    }
);
