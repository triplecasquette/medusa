import {
  AddToCartWorkflowInputDTO,
  CreateLineItemForCartDTO,
} from "@medusajs/framework/types"
import { CartWorkflowEvents, isDefined } from "@medusajs/framework/utils"
import {
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
  createLineItemsStep,
  getLineItemActionsStep,
  refreshCartShippingMethodsStep,
  updateLineItemsStep,
} from "../steps"
import { validateCartStep } from "../steps/validate-cart"
import { validateVariantPricesStep } from "../steps/validate-variant-prices"
import {
  cartFieldsForRefreshSteps,
  productVariantsFields,
} from "../utils/fields"
import { prepareLineItemData } from "../utils/prepare-line-item-data"
import { confirmVariantInventoryWorkflow } from "./confirm-variant-inventory"
import { refreshPaymentCollectionForCartWorkflow } from "./refresh-payment-collection"
import { updateCartPromotionsWorkflow } from "./update-cart-promotions"
import { updateTaxLinesWorkflow } from "./update-tax-lines"

export const addToCartWorkflowId = "add-to-cart"
/**
 * This workflow adds items to a cart.
 */
export const addToCartWorkflow = createWorkflow(
  addToCartWorkflowId,
  (input: WorkflowData<AddToCartWorkflowInputDTO>) => {
    validateCartStep(input)

    const variantIds = transform({ input }, (data) => {
      return (data.input.items ?? []).map((i) => i.variant_id).filter(isDefined)
    })

    // TODO: This is on par with the context used in v1.*, but we can be more flexible.
    const pricingContext = transform({ cart: input.cart }, (data) => {
      return {
        currency_code: data.cart.currency_code,
        region_id: data.cart.region_id,
        customer_id: data.cart.customer_id,
      }
    })

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

    const lineItems = transform({ input, variants }, (data) => {
      const items = (data.input.items ?? []).map((item) => {
        const variant = (data.variants ?? []).find(
          (v) => v.id === item.variant_id
        )!

        return prepareLineItemData({
          item,
          variant,
          cartId: data.input.cart.id,
          isCustomPrice: isDefined(item?.unit_price),
        }) as CreateLineItemForCartDTO
      })

      return items
    })

    const { itemsToCreate = [], itemsToUpdate = [] } = getLineItemActionsStep({
      id: input.cart.id,
      items: lineItems,
    })

    confirmVariantInventoryWorkflow.runAsStep({
      input: {
        sales_channel_id: input.cart.sales_channel_id as string,
        variants,
        items: input.items,
        itemsToUpdate,
      },
    })

    const [createdItems, updatedItems] = parallelize(
      createLineItemsStep({
        id: input.cart.id,
        items: itemsToCreate,
      }),
      updateLineItemsStep({
        id: input.cart.id,
        items: itemsToUpdate,
      })
    )

    const items = transform({ createdItems, updatedItems }, (data) => {
      return [...(data.createdItems || []), ...(data.updatedItems || [])]
    })

    const cart = useRemoteQueryStep({
      entry_point: "cart",
      fields: cartFieldsForRefreshSteps,
      variables: { id: input.cart.id },
      list: false,
    }).config({ name: "refetch–cart" })

    parallelize(
      refreshCartShippingMethodsStep({ cart }),
      emitEventStep({
        eventName: CartWorkflowEvents.UPDATED,
        data: { id: input.cart.id },
      })
    )

    updateTaxLinesWorkflow.runAsStep({
      input: {
        cart_id: input.cart.id,
        items,
      },
    })

    updateCartPromotionsWorkflow.runAsStep({
      input: {
        cart_id: input.cart.id,
      },
    })

    refreshPaymentCollectionForCartWorkflow.runAsStep({
      input: {
        cart_id: input.cart.id,
      },
    })

    return new WorkflowResponse(items)
  }
)
