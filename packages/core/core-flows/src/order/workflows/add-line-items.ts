import { OrderLineItemDTO, OrderWorkflow } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import {
  WorkflowData,
  WorkflowResponse,
  createWorkflow,
  parallelize,
  transform,
} from "@medusajs/framework/workflows-sdk"
import { findOneOrAnyRegionStep } from "../../cart/steps/find-one-or-any-region"
import { findOrCreateCustomerStep } from "../../cart/steps/find-or-create-customer"
import { findSalesChannelStep } from "../../cart/steps/find-sales-channel"
import { validateVariantPricesStep } from "../../cart/steps/validate-variant-prices"
import { prepareLineItemData } from "../../cart/utils/prepare-line-item-data"
import { confirmVariantInventoryWorkflow } from "../../cart/workflows/confirm-variant-inventory"
import { useRemoteQueryStep } from "../../common"
import { createOrderLineItemsStep } from "../steps"
import { productVariantsFields } from "../utils/fields"

function prepareLineItems(data) {
  const items = (data.input.items ?? []).map((item) => {
    const variant = data.variants.find((v) => v.id === item.variant_id)!

    return prepareLineItemData({
      variant: variant,
      taxLines: item.tax_lines || [],
      adjustments: item.adjustments || [],
    })
  })

  return items
}

export const addOrderLineItemsWorkflowId = "order-add-line-items"
/**
 * This workflow adds line items to an order.
 */
export const addOrderLineItemsWorkflow = createWorkflow(
  addOrderLineItemsWorkflowId,
  (
    input: WorkflowData<OrderWorkflow.OrderAddLineItemWorkflowInput>
  ): WorkflowResponse<OrderLineItemDTO[]> => {
    const order = useRemoteQueryStep({
      entry_point: "orders",
      fields: [
        "id",
        "sales_channel_id",
        "region_id",
        "customer_id",
        "email",
        "currency_code",
      ],
      variables: { id: input.order_id },
      list: false,
      throw_if_key_not_found: true,
    }).config({ name: "order-query" })

    const variantIds = transform({ input }, (data) => {
      return (data.input.items ?? [])
        .map((item) => item.variant_id)
        .filter(Boolean) as string[]
    })

    const [salesChannel, region, customerData] = parallelize(
      findSalesChannelStep({
        salesChannelId: order.sales_channel_id,
      }),
      findOneOrAnyRegionStep({
        regionId: order.region_id,
      }),
      findOrCreateCustomerStep({
        customerId: order.customer_id,
        email: order.email,
      })
    )

    const pricingContext = transform(
      { input, region, customerData, order },
      (data) => {
        if (!data.region) {
          throw new MedusaError(MedusaError.Types.NOT_FOUND, "Region not found")
        }

        return {
          currency_code: data.order.currency_code ?? data.region.currency_code,
          region_id: data.region.id,
          customer_id: data.customerData.customer?.id,
        }
      }
    )

    const variants = useRemoteQueryStep({
      entry_point: "variants",
      fields: productVariantsFields,
      variables: {
        id: variantIds,
        calculated_price: {
          context: pricingContext,
        },
      },
      throw_if_key_not_found: true,
    }).config({ name: "variants-query" })

    validateVariantPricesStep({ variants })

    confirmVariantInventoryWorkflow.runAsStep({
      input: {
        sales_channel_id: salesChannel.id,
        variants,
        items: input.items!,
      },
    })

    const lineItems = transform({ input, variants }, prepareLineItems)

    return new WorkflowResponse(
      createOrderLineItemsStep({
        items: lineItems,
      })
    )
  }
)
