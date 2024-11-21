import {
  AdditionalData,
  CreateCartWorkflowInputDTO,
} from "@medusajs/framework/types"
import {
  CartWorkflowEvents,
  isDefined,
  MedusaError,
} from "@medusajs/framework/utils"
import {
  createHook,
  createWorkflow,
  parallelize,
  transform,
  when,
  WorkflowData,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { emitEventStep } from "../../common/steps/emit-event"
import { useRemoteQueryStep } from "../../common/steps/use-remote-query"
import {
  createCartsStep,
  findOneOrAnyRegionStep,
  findOrCreateCustomerStep,
  findSalesChannelStep,
  getVariantPriceSetsStep,
} from "../steps"
import { validateVariantPricesStep } from "../steps/validate-variant-prices"
import { productVariantsFields } from "../utils/fields"
import { prepareLineItemData } from "../utils/prepare-line-item-data"
import { confirmVariantInventoryWorkflow } from "./confirm-variant-inventory"
import { refreshPaymentCollectionForCartWorkflow } from "./refresh-payment-collection"
import { updateCartPromotionsWorkflow } from "./update-cart-promotions"
import { updateTaxLinesWorkflow } from "./update-tax-lines"

export const createCartWorkflowId = "create-cart"
/**
 * This workflow creates a cart.
 */
export const createCartWorkflow = createWorkflow(
  createCartWorkflowId,
  (input: WorkflowData<CreateCartWorkflowInputDTO & AdditionalData>) => {
    const variantIds = transform({ input }, (data) => {
      return (data.input.items ?? []).map((i) => i.variant_id).filter(isDefined)
    })

    const [salesChannel, region, customerData] = parallelize(
      findSalesChannelStep({
        salesChannelId: input.sales_channel_id,
      }),
      findOneOrAnyRegionStep({
        regionId: input.region_id,
      }),
      findOrCreateCustomerStep({
        customerId: input.customer_id,
        email: input.email,
      })
    )

    // TODO: This is on par with the context used in v1.*, but we can be more flexible.
    const pricingContext = transform(
      { input, region, customerData },
      (data) => {
        if (!data.region) {
          throw new MedusaError(MedusaError.Types.NOT_FOUND, "No regions found")
        }

        return {
          currency_code: data.input.currency_code ?? data.region.currency_code,
          region_id: data.region.id,
          customer_id: data.customerData.customer?.id,
        }
      }
    )

    const variants = when({ variantIds }, ({ variantIds }) => {
      return !!variantIds.length
    }).then(() => {
      return useRemoteQueryStep({
        entry_point: "variants",
        fields: productVariantsFields,
        variables: {
          id: variantIds,
          calculated_price: {
            context: pricingContext,
          },
        },
        throw_if_key_not_found: true,
      })
    })

    validateVariantPricesStep({ variants })

    confirmVariantInventoryWorkflow.runAsStep({
      input: {
        sales_channel_id: salesChannel.id,
        variants,
        items: input.items!,
      },
    })

    const priceSets = getVariantPriceSetsStep({
      variantIds,
      context: pricingContext,
    })

    const cartInput = transform(
      { input, region, customerData, salesChannel },
      (data) => {
        if (!data.region) {
          throw new MedusaError(MedusaError.Types.NOT_FOUND, "No regions found")
        }

        const data_ = {
          ...data.input,
          currency_code: data.input.currency_code ?? data.region.currency_code,
          region_id: data.region.id,
        }

        if (data.customerData.customer?.id) {
          data_.customer_id = data.customerData.customer.id
          data_.email = data.input?.email ?? data.customerData.customer.email
        }

        if (data.salesChannel?.id) {
          data_.sales_channel_id = data.salesChannel.id
        }

        // If there is only one country in the region, we prepare a shipping address with that country's code.
        if (
          !data.input.shipping_address &&
          data.region.countries.length === 1
        ) {
          data_.shipping_address = {
            country_code: data.region.countries[0].iso_2,
          }
        }

        return data_
      }
    )

    const lineItems = transform({ priceSets, input, variants }, (data) => {
      const items = (data.input.items ?? []).map((item) => {
        const variant = data.variants.find((v) => v.id === item.variant_id)!
        const variantPrice = item.variant_id
          ? data.priceSets[item.variant_id]
          : undefined

        const unitPrice = item.unit_price || variantPrice?.calculated_amount
        const isTaxInclusive =
          item.is_tax_inclusive ||
          variantPrice?.is_calculated_price_tax_inclusive

        if (!isDefined(unitPrice)) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "Line item missing a unit price"
          )
        }

        return prepareLineItemData({
          item,
          unitPrice,
          isTaxInclusive,
          variant,
        })
      })

      return items
    })

    const cartToCreate = transform({ lineItems, cartInput }, (data) => {
      return {
        ...data.cartInput,
        items: data.lineItems,
      }
    })

    const carts = createCartsStep([cartToCreate])
    const cart = transform({ carts }, (data) => data.carts?.[0])

    updateTaxLinesWorkflow.runAsStep({
      input: {
        cart_id: cart.id,
      },
    })

    updateCartPromotionsWorkflow.runAsStep({
      input: {
        cart_id: cart.id,
        promo_codes: input.promo_codes,
      },
    })

    parallelize(
      refreshPaymentCollectionForCartWorkflow.runAsStep({
        input: {
          cart_id: cart.id,
        },
      }),
      emitEventStep({
        eventName: CartWorkflowEvents.CREATED,
        data: { id: cart.id },
      })
    )

    const cartCreated = createHook("cartCreated", {
      cart,
      additional_data: input.additional_data,
    })

    return new WorkflowResponse(cart, {
      hooks: [cartCreated],
    })
  }
)
