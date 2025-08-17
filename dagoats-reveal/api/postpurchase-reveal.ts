{\rtf1\ansi\ansicpg1252\cocoartf2822
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 // api/postpurchase-reveal.ts\
import type \{ VercelRequest, VercelResponse \} from 'vercel';\
import crypto from 'node:crypto';\
\
const SHOP = process.env.SHOPIFY_SHOP!; // p.ej. dagoats.myshopify.com\
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;\
const PACK_VARIANT_GID = process.env.PACK_VARIANT_GID!; // gid://shopify/ProductVariant/...\
const COLLECTION_HANDLE = process.env.COLLECTION_HANDLE || 'packs-bienvenido-a-dagoats';\
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';\
\
export default async function handler(req: VercelRequest, res: VercelResponse) \{\
  if (req.method === 'OPTIONS') \{\
    return withCORS(res).status(204).end();\
  \}\
  if (req.method !== 'POST') \{\
    return withCORS(res).status(405).json(\{ error: 'Method not allowed' \});\
  \}\
\
  try \{\
    const \{ shop, orderId, orderGID \} = req.body || \{\};\
    if (!orderGID || !shop || shop !== SHOP) \{\
      return withCORS(res).status(400).json(\{ error: 'Bad request' \});\
    \}\
\
    // 1) Carga de orden y validaciones\
    const qOrder = `\
      query($id: ID!) \{\
        order(id: $id) \{\
          id\
          financialStatus\
          metafield(namespace:"dagoats", key:"reveal_status") \{ value \}\
          lineItems(first: 100) \{\
            edges \{ node \{ id quantity variant \{ id \} \} \}\
          \}\
        \}\
      \}\
    `;\
    const orderResp = await gql(qOrder, \{ id: orderGID \});\
    const order = orderResp.data?.order;\
    if (!order) return withCORS(res).status(404).json(\{ error: 'Order not found' \});\
\
    if (order.metafield?.value === 'done') \{\
      return withCORS(res).status(200).json(\{ already: true \});\
    \}\
\
    const validFinancial = ['PAID', 'AUTHORIZED', 'PARTIALLY_PAID'].includes(order.financialStatus);\
    if (!validFinancial) \{\
      return withCORS(res).status(409).json(\{ error: 'Order not paid/authorized' \});\
    \}\
\
    const packLine = order.lineItems.edges.find((e: any) => e.node.variant?.id === PACK_VARIANT_GID);\
    if (!packLine) \{\
      return withCORS(res).status(400).json(\{ error: 'Pack not in order' \});\
    \}\
\
    // 2) Buscar candidatos de la colecci\'f3n oculta\
    const qCollection = `\
      query($handle:String!, $first:Int!) \{\
        collectionByHandle(handle:$handle) \{\
          products(first:$first) \{\
            edges \{\
              node \{\
                title\
                featuredImage \{ url \}\
                variants(first: 100) \{\
                  edges \{ node \{ id availableForSale inventoryQuantity \} \}\
                \}\
              \}\
            \}\
          \}\
        \}\
      \}\
    `;\
    const collResp = await gql(qCollection, \{ handle: COLLECTION_HANDLE, first: 250 \});\
    const prods = collResp.data?.collectionByHandle?.products?.edges?.map((e: any) => e.node) || [];\
\
    const candidates: Array<\{ variantId: string; title: string; image?: string \}> = [];\
    for (const p of prods) \{\
      for (const vEdge of p.variants.edges) \{\
        const v = vEdge.node;\
        const hasStock = v.availableForSale && (v.inventoryQuantity == null || v.inventoryQuantity > 0);\
        if (hasStock) candidates.push(\{ variantId: v.id, title: p.title, image: p.featuredImage?.url \});\
      \}\
    \}\
    if (!candidates.length) \{\
      return withCORS(res).status(409).json(\{ error: 'No stock to reveal' \});\
    \}\
\
    // 3) Selecci\'f3n aleatoria segura\
    const prize = candidates[crypto.randomInt(0, candidates.length)];\
\
    // 4) (Opcional) reserva de stock: omitir por brevedad (puedes usar Inventory API)\
\
    // 5) Order Edit (begin \uc0\u8594  remove pack \u8594  add prize \u8594  commit)\
    const begin = await gql(\
      `mutation($id:ID!)\{ orderEditBegin(id:$id)\{ calculatedOrder\{ id \} userErrors\{ message \} \} \}`,\
      \{ id: orderGID \}\
    );\
    const calcId = begin.data?.orderEditBegin?.calculatedOrder?.id;\
    if (!calcId) throw new Error('orderEditBegin failed');\
\
    await gql(\
      `mutation($calc:ID!, $line:ID!)\{\
        orderEditRemoveLineItem(id:$calc, lineItemId:$line)\{\
          calculatedOrder\{ id \} userErrors\{ message \}\
        \}\
      \}`,\
      \{ calc: calcId, line: packLine.node.id \}\
    );\
\
    // `orderEditAddVariant` aplica pricing contextual desde 2025-04 (si no quieres cambiar el total, iguala el precio con un custom item alternativo)\
    await gql(\
      `mutation($calc:ID!, $variant:ID!, $qty:Int!)\{\
        orderEditAddVariant(id:$calc, variantId:$variant, quantity:$qty)\{\
          calculatedOrder\{ id \} userErrors\{ message \}\
        \}\
      \}`,\
      \{ calc: calcId, variant: prize.variantId, qty: 1 \}\
    );\
\
    await gql(\
      `mutation($calc:ID!)\{\
        orderEditCommit(id:$calc, notifyCustomer:false, staffNote:"Dagoats reveal")\{\
          order \{ id \} userErrors\{ message \}\
        \}\
      \}`,\
      \{ calc: calcId \}\
    );\
\
    // 6) Metafields de auditor\'eda + idempotencia (metafieldsSet)\
    await gql(\
      `mutation($metafields: [MetafieldsSetInput!]!) \{\
        metafieldsSet(metafields: $metafields) \{\
          metafields \{ id \}\
          userErrors \{ message \}\
        \}\
      \}`,\
      \{\
        metafields: [\
          \{\
            ownerId: orderGID,\
            namespace: 'dagoats',\
            key: 'reveal_status',\
            type: 'single_line_text_field',\
            value: 'done'\
          \},\
          \{\
            ownerId: orderGID,\
            namespace: 'dagoats',\
            key: 'prize_variant_id',\
            type: 'single_line_text_field',\
            value: prize.variantId\
          \}\
        ]\
      \}\
    );\
\
    return withCORS(res).status(200).json(\{ prizeTitle: prize.title, prizeImage: prize.image \});\
  \} catch (err: any) \{\
    console.error(err);\
    return withCORS(res).status(500).json(\{ error: 'Reveal failed' \});\
  \}\
\}\
\
async function gql(query: string, variables: any) \{\
  const r = await fetch(`https://$\{SHOP\}/admin/api/$\{API_VERSION\}/graphql.json`, \{\
    method: 'POST',\
    headers: \{\
      'Content-Type': 'application/json',\
      'X-Shopify-Access-Token': ADMIN_TOKEN\
    \},\
    body: JSON.stringify(\{ query, variables \})\
  \});\
  const json = await r.json();\
  if (json.errors) throw new Error(JSON.stringify(json.errors));\
  return json;\
\}\
\
function withCORS(res: VercelResponse) \{\
  res.setHeader('Access-Control-Allow-Origin', '*');\
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');\
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');\
  return res;\
\}\
}