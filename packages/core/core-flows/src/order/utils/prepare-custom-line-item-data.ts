import { BigNumberInput } from "@medusajs/framework/types"
import {
  prepareAdjustmentsData,
  PrepareLineItemDataInput,
  prepareTaxLinesData,
} from "../../cart/utils/prepare-line-item-data"

interface Output {
  quantity: BigNumberInput
  title: string
  variant_sku?: string
  variant_barcode?: string
  variant_title?: string
  unit_price: BigNumberInput
  is_tax_inclusive: boolean
  metadata?: Record<string, any>
}

export function prepareCustomLineItemData(
  data: Omit<PrepareLineItemDataInput, "variant">
): Output {
  const { item, taxLines, adjustments } = data

  const lineItem: any = {
    quantity: item?.quantity,
    title: item?.title,

    // unit_price: unitPrice,
    // is_tax_inclusive: !!isTaxInclusive,
    metadata: item?.metadata ?? {},
  }

  if (taxLines) {
    lineItem.tax_lines = prepareTaxLinesData(taxLines)
  }

  if (adjustments) {
    lineItem.adjustments = prepareAdjustmentsData(adjustments)
  }

  return lineItem
}
