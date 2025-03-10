// Copyright (C) 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity 0.8.15;

import '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import './interfaces/IIndexerRegistry.sol';
import './interfaces/IServiceAgreementRegistry.sol';
import './interfaces/ISettings.sol';
import './interfaces/IPurchaseOfferMarket.sol';
import './interfaces/ISQToken.sol';
import './interfaces/IPlanManager.sol';
import './interfaces/IEraManager.sol';
import './interfaces/IStakingManager.sol';
import './Constants.sol';
import './utils/MathUtil.sol';
import './utils/SQParameter.sol';

/**
 * @title Purchase Offer Market Contract
 * @notice ### Overview
 * The Purchase Offer Market Contract tracks all purchase offers for Indexers and Consumers.
 * It allows Consumers to create/cancel purchase offers, and Indexers to accept the purchase offer to make
 * the service agreements. It is the place Consumer publish a purchase offer for a specific deployment.
 * And also the place indexers can search and take these purchase offers.
 *
 * ### Terminology
 * Purchase Offer: A Purchase Offer is created by the Consumer, any Indexer can accept it to make the
 * service agreement.
 *
 * ### Detail
 * We design the date structure for Purchase Offer, It stores purchase offer related information.
 * A Purchase Offer can accepted by multiple Indexers. Consumer transfer Token to this contract as long as
 * the purchase offer is created. And when Indexer accept the offer, the corresponding part of the money will
 * transfer to serviceAgrementRegistry contract first and wait rewardDistributer contract take and distribute.
 * After Indexer accept the offer we use the planTemplate that stored in Purchase Offer structure to generate
 * the service agreement.
 *
 * Consumers can cancel their purchase offer after expire date for free, but if cancel the unexpired Purchase Offer
 * we will charge the penalty fee.
 */
contract PurchaseOfferMarket is
    Initializable,
    OwnableUpgradeable,
    IPurchaseOfferMarket,
    SQParameter
{
    using SafeERC20 for IERC20;

    /**
     * @notice Purchase Offer information.
     */
    struct PurchaseOffer {
        //amount of SQT for each indexer, total deposit = deposit * limit
        uint256 deposit;
        //indexer must indexed to this height before accept the offer
        uint256 minimumAcceptHeight;
        //indexer must meet the minimum staking amount before accept the offer
        uint256 minimumStakingAmount;
        //planTemplate used to generate the service agreement.
        uint256 planTemplateId;
        //specific deployment id require for indexing
        bytes32 deploymentId;
        //offer expired date
        uint256 expireDate;
        //consumer who create this offer
        address consumer;
        //offer active or not
        bool active;
        //how many indexer can accept the offer
        uint16 limit;
        //number of contracts created from this offer
        uint16 numAcceptedContracts;
    }

    /// @dev ### STATES
    /// @notice ISettings contract which stores SubQuery network contracts address
    ISettings public settings;

    /// @notice offerId => Offer
    mapping(uint256 => PurchaseOffer) public offers;

    /// @notice number of all offers
    uint256 public numOffers;

    /// @notice penalty rate of consumer cancel the unexpired offer
    uint256 public penaltyRate;

    /// @notice if penalty destination address is 0x00, then burn the penalty
    address public penaltyDestination;

    /// @notice offerId => Indexer => _poi
    mapping(uint256 => mapping(address => bytes32)) public offerPoi;

    /// @dev ### EVENTS
    /// @notice Emitted when Consumer create a purchase offer
    event PurchaseOfferCreated(
        address consumer,
        uint256 offerId,
        bytes32 deploymentId,
        uint256 planTemplateId,
        uint256 deposit,
        uint16 limit,
        uint256 minimumAcceptHeight,
        uint256 minimumStakingAmount,
        uint256 expireDate
    );

    /// @notice Emitted when Consumer cancel a purchase offer
    event PurchaseOfferCancelled(address indexed creator, uint256 offerId, uint256 penalty);

    /// @notice Emitted when Indexer accept an offer
    event OfferAccepted(address indexed indexer, uint256 offerId, uint256 agreementId);

    /// @dev MODIFIER
    /// @notice require caller is indexer
    modifier onlyIndexer() {
        require(
            IIndexerRegistry(settings.getContractAddress(SQContracts.IndexerRegistry)).isIndexer(
                msg.sender
            ),
            'G002'
        );
        _;
    }

    /**
     * @notice Initialize this contract to set penaltyRate and penaltyDestination.
     * @param _settings ISettings contract
     * @param _penaltyRate penaltyRate that consumer cancel unexpired purchase offer
     * @param _penaltyDestination penaltyDestination that consumer cancel unexpired purchase offer
     */
    function initialize(
        ISettings _settings,
        uint256 _penaltyRate,
        address _penaltyDestination
    ) external initializer {
        __Ownable_init();
        require(_penaltyRate < PER_MILL, 'PO001');

        settings = _settings;
        penaltyRate = _penaltyRate;
        penaltyDestination = _penaltyDestination;

        emit Parameter('penaltyRate', abi.encodePacked(penaltyRate));
        emit Parameter('penaltyDestination', abi.encodePacked(penaltyDestination));
    }

    /**
     * @notice Update setting state.
     * @param _settings ISettings contract
     */
    function setSettings(ISettings _settings) external onlyOwner {
        settings = _settings;
    }

    /**
     * @notice allow admin the set the Penalty Rate for cancel unexpired offer.
     * @param _penaltyRate penalty rate to set
     */
    function setPenaltyRate(uint256 _penaltyRate) external onlyOwner {
        require(_penaltyRate < PER_MILL, 'PO001');
        penaltyRate = _penaltyRate;
        emit Parameter('penaltyRate', abi.encodePacked(penaltyRate));
    }

    /**
     * @notice allow admin to set the Penalty Destination address. All Penalty will transfer to this address, if penalty destination address is 0x00, then burn the penalty.
     * @param _penaltyDestination penalty destination to set
     */
    function setPenaltyDestination(address _penaltyDestination) external onlyOwner {
        penaltyDestination = _penaltyDestination;
        emit Parameter('penaltyDestination', abi.encodePacked(penaltyDestination));
    }

    /**
     * @notice Allow admin to create a Purchase Offer.
     * @param _deploymentId deployment id
     * @param _planTemplateId plan template id
     * @param _deposit purchase offer value to deposit
     * @param _limit limit indexer to accept the purchase offer
     * @param _minimumAcceptHeight minimum block height to accept the purchase offer
     * @param _minimumStakingAmount minimum staking amount to accept the purchase offer
     * @param _expireDate expire date of the purchase offer in unix timestamp
     */
    function createPurchaseOffer(
        bytes32 _deploymentId,
        uint256 _planTemplateId,
        uint256 _deposit,
        uint16 _limit,
        uint256 _minimumAcceptHeight,
        uint256 _minimumStakingAmount,
        uint256 _expireDate
    ) external {
        require(
            !(IEraManager(settings.getContractAddress(SQContracts.EraManager)).maintenance()),
            'G019'
        );
        require(_expireDate > block.timestamp, 'PO002');
        require(_deposit > 0, 'PO003');
        require(_limit > 0, 'PO004');

        IPlanManager planManager = IPlanManager(
            settings.getContractAddress(SQContracts.PlanManager)
        );
        PlanTemplateV2 memory template = planManager.getPlanTemplate(_planTemplateId);
        require(template.active, 'PO005');
        require(template.priceToken == settings.getContractAddress(SQContracts.SQToken));

        offers[numOffers] = PurchaseOffer(
            _deposit,
            _minimumAcceptHeight,
            _minimumStakingAmount,
            _planTemplateId,
            _deploymentId,
            _expireDate,
            msg.sender,
            true,
            _limit,
            0
        );

        // send SQToken from msg.sender to the contract (this) - deposit * limit
        require(
            IERC20(settings.getContractAddress(SQContracts.SQToken)).transferFrom(
                msg.sender,
                address(this),
                _deposit * _limit
            ),
            'G013'
        );

        emit PurchaseOfferCreated(
            msg.sender,
            numOffers,
            _deploymentId,
            _planTemplateId,
            _deposit,
            _limit,
            _minimumAcceptHeight,
            _minimumStakingAmount,
            _expireDate
        );

        numOffers++;
    }

    /**
     * @notice Allow Consumer to cancel their Purchase Offer. Consumer transfer all tokens to this contract when they create the offer. We will charge a Penalty to cancel unexpired Offer. And the Penalty will transfer to a configured address. If the address not configured, then we burn the Penalty.
     * @param _offerId purchase offer id to cancel
     */
    function cancelPurchaseOffer(uint256 _offerId) external {
        require(
            !(IEraManager(settings.getContractAddress(SQContracts.EraManager)).maintenance()),
            'G019'
        );
        PurchaseOffer memory offer = offers[_offerId];
        require(msg.sender == offer.consumer, 'PO006');
        require(offers[_offerId].active, 'PO007');

        //- deposit * limit
        uint256 unfulfilledValue = offer.deposit * (offer.limit - offer.numAcceptedContracts);
        uint256 penalty = 0;
        if (!isExpired(_offerId)) {
            penalty = MathUtil.mulDiv(penaltyRate, unfulfilledValue, PER_MILL);
            unfulfilledValue = unfulfilledValue - penalty;
            if (penaltyDestination != ZERO_ADDRESS) {
                IERC20(settings.getContractAddress(SQContracts.SQToken)).transfer(
                    penaltyDestination,
                    penalty
                );
            } else {
                address treasury = settings.getContractAddress(SQContracts.Treasury);
                IERC20(settings.getContractAddress(SQContracts.SQToken)).safeTransfer(
                    treasury,
                    penalty
                );
            }
        }

        // send remaining SQToken from the contract to consumer (this)
        require(
            IERC20(settings.getContractAddress(SQContracts.SQToken)).transfer(
                msg.sender,
                unfulfilledValue
            ),
            'G013'
        );

        delete offers[_offerId];

        emit PurchaseOfferCancelled(msg.sender, _offerId, penalty);
    }

    /**
     * @notice Allow Indexer to accept the offer and make the service agreement.
     * The corresponding part of the money will transfer to serviceAgrementRegistry contract
     * and wait rewardDistributer contract take and distribute as long as Indexer accept the offer.
     * When Indexer accept the offer we need to ensure Indexer's deployment reaches the minimumAcceptHeight,
     * So we ask indexers to pass the latest poi value when accepting the purchase offer,
     * and save this poi value when agreement create.
     * @param _offerId purchase offer id to accept
     * @param _poi proof of index (hash) to accept the purchase offer
     */
    function acceptPurchaseOffer(uint256 _offerId, bytes32 _poi) external onlyIndexer {
        require(
            !(IEraManager(settings.getContractAddress(SQContracts.EraManager)).maintenance()),
            'G019'
        );
        PurchaseOffer storage offer = offers[_offerId];
        require(offer.active, 'PO007');
        require(!isExpired(_offerId), 'PO008');
        require(_poi != bytes32(0), 'PO011');
        require(offerPoi[_offerId][msg.sender] == bytes32(0), 'PO009');
        require(offer.limit > offer.numAcceptedContracts, 'PO010');

        IStakingManager stakingManager = IStakingManager(
            settings.getContractAddress(SQContracts.StakingManager)
        );
        require(
            stakingManager.getTotalStakingAmount(msg.sender) >= offer.minimumStakingAmount,
            'PO013'
        );

        IPlanManager planManager = IPlanManager(
            settings.getContractAddress(SQContracts.PlanManager)
        );
        PlanTemplateV2 memory template = planManager.getPlanTemplate(offer.planTemplateId);
        require(template.active, 'PO005');

        // increate number of accepted contracts
        offer.numAcceptedContracts++;
        // flag offer accept to avoid double accept
        offerPoi[_offerId][msg.sender] = _poi;
        // create closed service agreement contract
        ClosedServiceAgreementInfo memory agreement = ClosedServiceAgreementInfo(
            offer.consumer,
            msg.sender,
            offer.deploymentId,
            offer.deposit,
            block.timestamp,
            template.period,
            0,
            offer.planTemplateId
        );

        // deposit SQToken into the service agreement registry contract
        require(
            IERC20(settings.getContractAddress(SQContracts.SQToken)).transfer(
                settings.getContractAddress(SQContracts.ServiceAgreementRegistry),
                offer.deposit
            ),
            'G013'
        );
        // register the agreement to service agreement registry contract
        IServiceAgreementRegistry registry = IServiceAgreementRegistry(
            settings.getContractAddress(SQContracts.ServiceAgreementRegistry)
        );
        uint256 agreementId = registry.createClosedServiceAgreement(agreement);

        emit OfferAccepted(msg.sender, _offerId, agreementId);
    }

    /**
     * @notice Return the purchase offer is expired
     * @param _offerId purchase offer id
     * @return bool the result of is the purchase offer expired
     */
    function isExpired(uint256 _offerId) public view returns (bool) {
        return offers[_offerId].expireDate < block.timestamp;
    }
}
