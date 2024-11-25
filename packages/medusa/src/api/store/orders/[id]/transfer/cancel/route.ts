import {
  cancelOrderTransferRequestWorkflow,
  getOrderDetailWorkflow,
} from "@medusajs/core-flows"
import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { HttpTypes } from "@medusajs/framework/types"
import { StoreCancelOrderTransferRequestType } from "../../../validators"

export const POST = async (
  req: AuthenticatedMedusaRequest<StoreCancelOrderTransferRequestType>,
  res: MedusaResponse<HttpTypes.StoreOrderResponse>
) => {
  const orderId = req.params.id
  const customerId = req.auth_context.actor_id

  await cancelOrderTransferRequestWorkflow(req.scope).run({
    input: {
      order_id: orderId,
      logged_in_user_id: customerId,
      actor_type: req.auth_context.actor_type as "customer",
    },
  })

  const { result } = await getOrderDetailWorkflow(req.scope).run({
    input: {
      fields: req.remoteQueryConfig.fields,
      order_id: orderId,
    },
  })

  res.status(200).json({ order: result as HttpTypes.StoreOrder })
}
